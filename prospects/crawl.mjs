// Fetching a business site politely enough that nobody minds.
//
// These are small firms on shared hosting. The limits below are deliberately
// conservative: a handful of pages per site, one request at a time per host,
// a pause between them, and robots.txt respected. Finding twenty contacts is
// not worth degrading someone's website.

import { extractEmails, findContactLinks } from './extract.mjs';

export const USER_AGENT =
  'finder-prospects/1.0 (small-scale B2B contact lookup; contact the operator of this tool to be excluded)';

const DEFAULTS = {
  maxPages: 5,        // homepage plus a few contact-ish pages
  timeoutMs: 12000,
  delayMs: 1200,      // between requests to the same host
  maxBytes: 2_000_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function siteDomain(url) {
  try {
    // host, not hostname: it carries a non-default port. Real sites never have
    // one (URL drops :443 and :80), so this is identical in production and
    // keeps two services on one machine from collapsing into one prospect.
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Accept bare hostnames the way a person types them. */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

async function get(url, { timeoutMs, fetchImpl, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const type = res.headers?.get?.('content-type') ?? '';
    if (!res.ok) return { ok: false, status: res.status, body: '' };
    // A PDF or image would waste the byte budget and yield nothing.
    if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      return { ok: true, status: res.status, body: '', skipped: 'not-html' };
    }
    const body = await res.text();
    return { ok: true, status: res.status, body: body.slice(0, maxBytes), url: res.url ?? url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal robots.txt: the Disallow rules that apply to us.
 *
 * Deliberately strict about what it understands -- anything unparsed is treated
 * as "no rule", but a matching Disallow always wins. Being over-cautious costs
 * one prospect; being under-cautious means ignoring an explicit request.
 */
export function parseRobots(text, agent = 'finder-prospects') {
  const groups = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const clean = line.split('#')[0].trim();
    if (clean === '') continue;
    const [rawKey, ...rest] = clean.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current?.fresh) current = { agents: [], rules: [], fresh: true };
      current.agents.push(value.toLowerCase());
      if (!groups.includes(current)) groups.push(current);
    } else if (key === 'disallow' && current) {
      current.fresh = false;
      if (value !== '') current.rules.push(value);
    } else if (current) {
      current.fresh = false;
    }
  }

  const lower = agent.toLowerCase();
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && lower.includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  return (mine ?? star)?.rules ?? [];
}

export function isAllowed(pathname, rules) {
  return !rules.some((rule) => pathname.startsWith(rule));
}

/**
 * Crawl one business site and return the addresses on it.
 *
 * Never throws: a dead domain is an ordinary outcome when working from a
 * scraped list, and one bad site must not end the run.
 */
export async function crawlSite(input, options = {}) {
  const opts = { ...DEFAULTS, fetchImpl: fetch, ...options };
  const url = normalizeUrl(input);
  const domain = siteDomain(url);
  const result = { input: String(input), url, domain, pages: [], emails: [], status: 'ok', error: '' };

  if (!url) {
    return { ...result, status: 'bad-url', error: 'Not a usable website address' };
  }

  let rules = [];
  try {
    const robots = await get(new URL('/robots.txt', url).toString(), opts);
    if (robots.ok && robots.body) rules = parseRobots(robots.body);
  } catch {
    // No robots.txt is the common case and means no restrictions.
  }

  const queue = [url];
  const seen = new Set();
  const emails = new Map();

  while (queue.length > 0 && result.pages.length < opts.maxPages) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);

    let path;
    try {
      path = new URL(next).pathname;
    } catch {
      continue;
    }
    if (!isAllowed(path, rules)) {
      result.pages.push({ url: next, skipped: 'robots' });
      continue;
    }

    if (result.pages.length > 0) await sleep(opts.delayMs);

    let page;
    try {
      page = await get(next, opts);
    } catch (err) {
      // Node's bare "fetch failed" says nothing; the cause carries the reason.
      const reason = err.name === 'AbortError'
        ? 'timed out'
        : ({ ENOTFOUND: 'domain does not resolve', ECONNREFUSED: 'nothing listening',
             ECONNRESET: 'connection reset', CERT_HAS_EXPIRED: 'expired certificate',
             ERR_TLS_CERT_ALTNAME_INVALID: 'certificate does not match' }[err.cause?.code] ??
           err.cause?.code ?? err.message);
      result.pages.push({ url: next, error: reason });
      if (result.pages.length === 1) { result.status = 'unreachable'; result.error = reason; }
      continue;
    }

    if (!page.ok) {
      result.pages.push({ url: next, status: page.status });
      if (seen.size === 1) { result.status = 'unreachable'; result.error = `HTTP ${page.status}`; }
      continue;
    }

    const hits = extractEmails(page.body, { siteDomain: domain });
    for (const hit of hits) if (!emails.has(hit.email)) emails.set(hit.email, { ...hit, page: next });
    result.pages.push({ url: next, emails: hits.length });

    // Only follow links from the homepage; deeper crawling finds blog authors,
    // not the business.
    if (seen.size === 1) {
      for (const link of findContactLinks(page.body, page.url ?? next, { max: opts.maxPages - 1 })) {
        if (!seen.has(link)) queue.push(link);
      }
    }
  }

  result.emails = [...emails.values()];
  if (result.status === 'ok' && result.emails.length === 0) result.status = 'no-email';
  return result;
}
