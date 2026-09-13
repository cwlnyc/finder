import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { extractEmails, findContactLinks, isPlausible } from './extract.mjs';
import { crawlSite, isAllowed, normalizeUrl, parseRobots, siteDomain } from './crawl.mjs';
import { addSites, readProspects, updateProspect } from './store.mjs';
import { parseSiteFile } from './input.mjs';

// --- extraction --------------------------------------------------------

test('a mailto link outranks the same address found in body text', () => {
  // Someone deliberately linked it; a match in prose might be a customer's.
  const html = '<p>write to sales@acme.com</p><a href="mailto:info@acme.com">Email us</a>';
  const [first] = extractEmails(html, { siteDomain: 'acme.com' });
  assert.equal(first.email, 'info@acme.com');
  assert.equal(first.source, 'mailto');
});

test('template and tracking junk never reaches the list', () => {
  // Every one of these turns up on real small-business sites, and each would
  // otherwise look like a lead until the mail bounced.
  const html = `
    <img src="logo@2x.png"><img src="hero@3x.jpg">
    <script>Sentry.init({dsn:"https://u1234567890@o12345.ingest.sentry.io/1"})</script>
    <p>you@example.com — name@yourdomain.com — noreply@acme.com — postmaster@acme.com</p>
    <a href="mailto:real@acme.com">us</a>`;
  const emails = extractEmails(html, { siteDomain: 'acme.com' }).map((e) => e.email);
  assert.deepEqual(emails, ['real@acme.com']);
});

test('addresses obfuscated to dodge scrapers are still read', () => {
  for (const spelling of [
    'hello [at] acme [dot] com', 'hello (at) acme (dot) com', 'hello at acme dot com',
  ]) {
    const emails = extractEmails(`<p>${spelling}</p>`).map((e) => e.email);
    assert.ok(emails.includes('hello@acme.com'), spelling);
  }
});

test('an address on the business\'s own domain sorts above a gmail', () => {
  const html = '<p>owner@gmail.com and office@acme.com</p>';
  const emails = extractEmails(html, { siteDomain: 'acme.com' }).map((e) => e.email);
  assert.deepEqual(emails, ['office@acme.com', 'owner@gmail.com']);
});

test('isPlausible rejects what looks like an address but is not', () => {
  for (const bad of [
    'logo@2x.png', 'a@example.com', 'noreply@acme.com', 'u1234567890@sentry.io',
    'deadbeefcafe1234@acme.com', 'no-at-sign.com', '@acme.com', 'x@acme',
    'x@.com', 'x@acme..com',
  ]) {
    assert.equal(isPlausible(bad), false, bad);
  }
  for (const good of ['info@acme.com', 'first.last@acme.co.uk', 'sales+ny@acme-ins.com']) {
    assert.equal(isPlausible(good), true, good);
  }
});

test('contact links are same-host, ranked, and capped', () => {
  const html = `
    <a href="/blog">Blog</a>
    <a href="https://facebook.com/acme/contact">Facebook</a>
    <a href="/about-us">About</a>
    <a href="/contact">Contact</a>
    <a href="/our-team">Team</a>
    <a href="/locations">Locations</a>
    <a href="/agents">Agents</a>`;
  const links = findContactLinks(html, 'https://acme.com/', { max: 3 });
  assert.equal(links.length, 3);
  assert.ok(links[0].endsWith('/contact'), 'contact leads');
  assert.ok(!links.some((l) => l.includes('facebook')), 'never leaves the site');
  assert.ok(!links.some((l) => l.includes('blog')), 'blog is not a contact page');
});

// --- urls & robots -----------------------------------------------------

test('a bare hostname is accepted the way people type it', () => {
  assert.equal(normalizeUrl('acme.com'), 'https://acme.com/');
  assert.equal(normalizeUrl('  https://acme.com/x#y '), 'https://acme.com/x');
  assert.equal(siteDomain('https://WWW.Acme.com/x'), 'acme.com');
  for (const bad of ['', 'not a url', 'ftp://acme.com', 'localhost', null]) {
    assert.equal(normalizeUrl(bad), '', String(bad));
  }
});

test('robots.txt rules for us beat the wildcard group', () => {
  const rules = parseRobots(
    'User-agent: *\nDisallow: /admin\n\nUser-agent: finder-prospects\nDisallow: /private\n',
  );
  assert.deepEqual(rules, ['/private'], 'our own group wins outright');
  assert.equal(isAllowed('/contact', rules), true);
  assert.equal(isAllowed('/private/x', rules), false);
});

test('an empty Disallow means everything is allowed', () => {
  const rules = parseRobots('User-agent: *\nDisallow:\n');
  assert.deepEqual(rules, []);
  assert.equal(isAllowed('/anything', rules), true);
});

// --- crawling a real server -------------------------------------------

let server;
let base;

before(async () => {
  const pages = {
    // /staff is both a page we would want (it matches a contact pattern) and
    // one robots.txt forbids -- the only combination that tests the rule.
    '/robots.txt': 'User-agent: *\nDisallow: /staff\n',
    '/': `<html><a href="/contact">Contact Us</a><a href="/staff">Our Staff</a>
          <a href="/private">Members</a><a href="https://twitter.com/acme">Twitter</a></html>`,
    '/contact': '<a href="mailto:info@broker-test.com">Email</a><p>backup: sales@broker-test.com</p>',
    '/staff': '<p>staffonly@broker-test.com</p>',
    '/private': '<p>secret@broker-test.com</p>',
    '/nothing': '<html><p>no way to reach us</p></html>',
    '/slow': null, // never responds
  };
  server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/slow') return; // deliberately hangs
    if (!(path in pages)) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pages[path]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await new Promise((r) => server.close(r)); });

const fast = { delayMs: 0, timeoutMs: 2000 };

test('crawling follows the contact page and collects addresses', async () => {
  const result = await crawlSite(base, fast);
  assert.equal(result.status, 'ok');
  const emails = result.emails.map((e) => e.email);
  assert.ok(emails.includes('info@broker-test.com'));
  assert.ok(emails.includes('sales@broker-test.com'));
  assert.equal(emails[0], 'info@broker-test.com', 'the mailto is offered first');
});

test('a page we want but robots forbids is queued and then skipped', async () => {
  const result = await crawlSite(base, fast);
  const staff = result.pages.find((p) => p.url.endsWith('/staff'));
  assert.equal(staff?.skipped, 'robots', 'it was worth visiting, and we did not');
  assert.ok(!result.emails.some((e) => e.email === 'staffonly@broker-test.com'),
    'nothing from a page we agreed not to read');
});

test('a page that is not contact-shaped is never queued at all', async () => {
  const result = await crawlSite(base, fast);
  assert.ok(!result.pages.some((p) => p.url.endsWith('/private')), 'no reason to look');
  assert.ok(!result.emails.some((e) => e.email === 'secret@broker-test.com'));
});

test('a site with no address is recorded as such, not as a failure', async () => {
  const result = await crawlSite(`${base}/nothing`, fast);
  assert.equal(result.status, 'no-email');
  assert.deepEqual(result.emails, []);
});

test('a dead site ends the crawl for that site only', async () => {
  const result = await crawlSite('https://127.0.0.1:1/', { ...fast, timeoutMs: 800 });
  assert.equal(result.status, 'unreachable');
  assert.ok(result.error, 'and says why');
});

test('a hanging site times out instead of stalling the run', async () => {
  const started = Date.now();
  const result = await crawlSite(`${base}/slow`, { ...fast, timeoutMs: 700 });
  assert.equal(result.status, 'unreachable');
  assert.ok(Date.now() - started < 4000, 'gave up promptly');
});

test('an unusable address is rejected without a request', async () => {
  const result = await crawlSite('not a website', fast);
  assert.equal(result.status, 'bad-url');
  assert.deepEqual(result.pages, []);
});

// --- input parsing -----------------------------------------------------

test('a plain list of URLs is accepted', () => {
  const sites = parseSiteFile('acme.com\nhttps://www.beta.com/\n\n  gamma.co.uk  \n');
  assert.deepEqual(sites.map((s) => s.domain), ['acme.com', 'beta.com', 'gamma.co.uk']);
});

test('a CSV is read by column name, in any order', () => {
  // Whatever Mason or a Maps copy-paste produces, rather than a fixed layout.
  const sites = parseSiteFile('Phone,Website,Business\n555,acme.com,"Acme Insurance, Inc."\n555,beta.com,Beta');
  assert.deepEqual(sites.map((s) => s.domain), ['acme.com', 'beta.com']);
  assert.equal(sites[0].name, 'Acme Insurance, Inc.', 'quoted commas survive');
});

test('the same business listed twice is one prospect', () => {
  // Two searches overlapping is the normal case, and mailing someone twice
  // because of it is the thing to avoid.
  const sites = parseSiteFile('Website\nhttps://acme.com/contact\nhttp://www.acme.com/\nbeta.com');
  assert.deepEqual(sites.map((s) => s.domain), ['acme.com', 'beta.com']);
});

test('rows without a usable site are dropped, not stored empty', () => {
  const sites = parseSiteFile('Website,Name\n,No Site Co\nnot a url,Bad Co\nacme.com,Good Co');
  assert.deepEqual(sites.map((s) => s.name), ['Good Co']);
});

// --- store -------------------------------------------------------------

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'prospects-test-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('adding the same domain again never duplicates it', async () => {
  await withTempDir(async (dir) => {
    await addSites([{ domain: 'acme.com', url: 'https://acme.com/', name: '' }], { dir });
    const second = await addSites([
      { domain: 'acme.com', url: 'https://acme.com/', name: 'Acme Insurance' },
      { domain: 'beta.com', url: 'https://beta.com/', name: 'Beta' },
    ], { dir });
    assert.deepEqual({ added: second.added, skipped: second.skipped, total: second.total },
      { added: 1, skipped: 1, total: 2 });
    const rows = await readProspects(dir);
    assert.equal(rows.find((r) => r.domain === 'acme.com').name, 'Acme Insurance',
      'a name we did not have is filled in');
  });
});

test('marking a prospect emailed survives a reload', async () => {
  await withTempDir(async (dir) => {
    await addSites([{ domain: 'acme.com', url: 'https://acme.com/', name: 'Acme' }], { dir });
    await updateProspect('acme', { emailedAt: '2026-09-12T00:00:00Z' }, { dir });
    const rows = await readProspects(dir);
    assert.equal(rows[0].emailedAt, '2026-09-12T00:00:00Z');
  });
});

test('an ambiguous match refuses rather than picking one', async () => {
  await withTempDir(async (dir) => {
    await addSites([
      { domain: 'acme.com', url: 'https://acme.com/', name: '' },
      { domain: 'acme.net', url: 'https://acme.net/', name: '' },
    ], { dir });
    await assert.rejects(() => updateProspect('acme', { emailedAt: 'x' }, { dir }), /matches 2/);
    await assert.rejects(() => updateProspect('nope', { emailedAt: 'x' }, { dir }), /No prospect/);
  });
});

test('a non-default port is part of a site\'s identity', () => {
  // Real sites never carry one -- URL drops :443 and :80 -- so this only ever
  // matters when two services share a host, which is exactly when collapsing
  // them into one prospect would be wrong.
  assert.equal(siteDomain('https://acme.com:443/'), 'acme.com');
  assert.equal(siteDomain('http://acme.com:80/'), 'acme.com');
  assert.equal(siteDomain('http://127.0.0.1:4101/'), '127.0.0.1:4101');
  assert.notEqual(siteDomain('http://127.0.0.1:4101/'), siteDomain('http://127.0.0.1:4102/'));
});

test('contact links are matched however the site spells them', () => {
  // "Our Team" with a space is at least as common as "our-team", and a pattern
  // that only allowed the hyphen quietly skipped half of real sites.
  const html = `
    <a href="/team">Our Team</a>
    <a href="/x1">Get In Touch</a>
    <a href="/x2">Reach Us</a>
    <a href="/meet_the_staff">Meet the staff</a>`;
  const links = findContactLinks(html, 'https://acme.com/', { max: 9 });
  assert.equal(links.length, 4, 'every spelling is followed');
});
