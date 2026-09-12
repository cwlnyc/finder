// Pulling contact addresses out of a page.
//
// A bare email regex over raw HTML is mostly wrong: it matches image filenames
// like logo@2x.png, analytics keys, and the placeholder addresses that ship
// inside site templates. Everything below exists to throw those away, because a
// prospect list padded with junk is worse than a short one -- you find out it
// was junk after you have already sent the mail.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

// "info [at] example [dot] com" and friends. Small shops obfuscate constantly.
const OBFUSCATED = /([A-Za-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\}|\sat\s)\s*([A-Za-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s)\s*([A-Za-z]{2,24})/gi;

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|woff2?|ttf|eot|pdf|mp4|webm)$/i;

// Domains that only ever appear in templates, tracking snippets, or docs.
const JUNK_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'domain.com', 'yourdomain.com',
  'yoursite.com', 'email.com', 'test.com', 'sentry.io', 'wixpress.com',
  'sentry-next.wixpress.com', 'godaddy.com', 'squarespace.com', 'wix.com',
  'placeholder.com', 'company.com', 'mysite.com', 'website.com', 'name.com',
]);

// Addresses nobody reads, or that exist for machines.
const JUNK_LOCAL = /^(no-?reply|donotreply|do-not-reply|postmaster|mailer-daemon|bounce|abuse|sentry|u\d{6,}|[0-9a-f]{16,})$/i;

// Retina image markers survive the extension filter when the URL is truncated.
const RETINA = /^\d+x$/i;

function clean(candidate) {
  return candidate.trim().replace(/^[.,;:<("'-]+/, '').replace(/[.,;:>)"'-]+$/, '').toLowerCase();
}

/** True when this looks like a real address a person reads. */
export function isPlausible(email) {
  if (!email || ASSET_EXT.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > 64 || domain.length > 253) return false;
  if (JUNK_LOCAL.test(local) || RETINA.test(domain.split('.')[0])) return false;
  if (JUNK_DOMAINS.has(domain)) return false;
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/.test(domain)) return false;
  if (domain.startsWith('.') || domain.includes('..')) return false;
  // A long hex local part is a tracking key, not a person.
  if (/^[0-9a-f]{12,}$/i.test(local)) return false;
  return true;
}

/**
 * Every plausible address on a page, most trustworthy first.
 *
 * A mailto: link is a deliberate act by whoever built the site; an address
 * found loose in the body text might be a customer's, a vendor's, or an
 * example. Both are kept, but the order says which to try.
 */
export function extractEmails(html, { siteDomain } = {}) {
  const found = new Map(); // email -> {email, source, onDomain}

  const record = (raw, source) => {
    const email = clean(raw);
    if (!isPlausible(email)) return;
    const existing = found.get(email);
    // mailto beats body text; never downgrade an entry we already trust.
    if (existing && existing.source === 'mailto') return;
    found.set(email, {
      email,
      source,
      onDomain: siteDomain ? email.endsWith(`@${siteDomain}`) || email.endsWith(`.${siteDomain}`) : false,
    });
  };

  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"'?>]+)/gi)) {
    record(decodeURIComponent(m[1]), 'mailto');
  }
  // Strip scripts and styles before scanning text: that is where the tracking
  // keys and template placeholders live.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  for (const m of text.matchAll(EMAIL)) record(m[0], 'text');
  for (const m of text.matchAll(OBFUSCATED)) record(`${m[1]}@${m[2]}.${m[3]}`, 'obfuscated');

  const rank = (e) =>
    (e.source === 'mailto' ? 0 : e.source === 'obfuscated' ? 1 : 2) * 10 + (e.onDomain ? 0 : 1);
  return [...found.values()].sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email));
}

// Pages worth following from a homepage. Ordered: the earlier the pattern, the
// more likely the page carries a real address.
// Separators are flexible on purpose: the path says "our-team" and the link
// text says "Our Team", and a pattern that only allows a hyphen misses half of
// real sites.
const SEP = '[\\s._/-]*';
const CONTACT_HINTS = [
  /contact/i,
  new RegExp(`get${SEP}in${SEP}touch`, 'i'),
  new RegExp(`reach${SEP}us`, 'i'),
  /about/i,
  /\bteam\b/i,
  /staff/i,
  /\bagents?\b/i,
  /people/i,
  /locations?/i,
];

/** Same-site links that look like they lead to contact details. */
export function findContactLinks(html, baseUrl, { max = 4 } = {}) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const scored = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    let url;
    try {
      url = new URL(m[1], base);
    } catch {
      continue;
    }
    // Same host only: a Facebook or LinkedIn link is not this business's site.
    if (url.host !== base.host) continue;
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';

    const label = m[2].replace(/<[^>]*>/g, ' ');
    const haystack = `${url.pathname} ${label}`;
    const rank = CONTACT_HINTS.findIndex((re) => re.test(haystack));
    if (rank === -1) continue;
    const href = url.toString();
    if (href === baseUrl) continue;
    if (!scored.has(href) || scored.get(href) > rank) scored.set(href, rank);
  }

  return [...scored.entries()].sort((a, b) => a[1] - b[1]).slice(0, max).map(([href]) => href);
}
