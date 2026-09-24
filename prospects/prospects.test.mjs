import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { extractEmails, findContactLinks, isPlausible } from './extract.mjs';
import { crawlSite, isAllowed, normalizeUrl, parseRobots, siteDomain } from './crawl.mjs';
import { addSites, exportable, readProspects, updateProspect } from './store.mjs';
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

test('a prospect can be marked by the address the send preview showed', async () => {
  // The preview lists addresses, so that is what you have in hand when you
  // spot a wrong-fit one. A captive agent's mail also tends to live on a
  // carrier domain that the crawled website never mentions.
  await withTempDir(async (dir) => {
    await addSites([{ domain: 'mccordagency.com', url: 'https://mccordagency.com/', name: 'McCord' }], { dir });
    await updateProspect('mccordagency.com', { emails: ['michael_mccord@american-national.com'] }, { dir });

    await updateProspect('michael_mccord@american-national.com', { status: 'skip' }, { dir });
    assert.equal((await readProspects(dir))[0].status, 'skip', 'the whole address works');

    await updateProspect('american-national.com', { notes: 'captive' }, { dir });
    assert.equal((await readProspects(dir))[0].notes, 'captive', 'so does the address domain');
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

// --- google places -----------------------------------------------------

import { BUYER_PRESETS, getPreset, PlacesError, searchPlaces } from './places.mjs';

const placesReply = (payload, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const onePlace = (over = {}) => ({
  id: 'ChIJtest', displayName: { text: 'Sterling Insurance', languageCode: 'en' },
  formattedAddress: '1 Main St, Brooklyn, NY 11218, USA',
  websiteUri: 'https://sterlingins.example', nationalPhoneNumber: '(718) 555-0100',
  ...over,
});

test('a search returns businesses with their websites', async () => {
  const result = await searchPlaces('insurance broker Brooklyn', {
    apiKey: 'k',
    fetchImpl: placesReply({ places: [onePlace(), onePlace({ id: 'b', displayName: { text: 'Boro' }, websiteUri: 'https://boro.example' })] }),
  });
  assert.equal(result.searched, 2);
  assert.equal(result.places.length, 2);
  assert.deepEqual(result.places[0], {
    placeId: 'ChIJtest', name: 'Sterling Insurance', website: 'https://sterlingins.example',
    phone: '(718) 555-0100', address: '1 Main St, Brooklyn, NY 11218, USA',
  });
});

test('businesses with no website are counted, not stored', async () => {
  // Nothing can be crawled for an address, so keeping them would fill the list
  // with rows that can never produce a contact.
  const result = await searchPlaces('q', {
    apiKey: 'k',
    fetchImpl: placesReply({ places: [onePlace(), onePlace({ websiteUri: undefined })] }),
  });
  assert.equal(result.searched, 2);
  assert.equal(result.places.length, 1);
  assert.equal(result.withoutWebsite, 1);
});

test('the request carries the key and the field mask', async () => {
  let seen;
  await searchPlaces('brokers', {
    apiKey: 'secret-key',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ places: [onePlace()] }) }; },
  });
  assert.match(seen.url, /places\.googleapis\.com\/v1\/places:searchText/);
  assert.equal(seen.init.headers['X-Goog-Api-Key'], 'secret-key');
  // Without websiteUri in the mask the API omits it and every result looks
  // website-less -- the single most likely way this breaks.
  assert.match(seen.init.headers['X-Goog-FieldMask'], /places\.websiteUri/);
  assert.equal(JSON.parse(seen.init.body).textQuery, 'brokers');
});

test('a missing key is caught before any request is made', async () => {
  let called = false;
  await assert.rejects(
    () => searchPlaces('x', { apiKey: '', fetchImpl: async () => { called = true; } }),
    (err) => { assert.ok(err instanceof PlacesError); assert.match(err.message, /GOOGLE_PLACES_API_KEY/); return true; },
  );
  assert.equal(called, false, 'no point spending a request to be told the key is missing');
});

test('each Google failure names its own fix', async () => {
  const cases = [
    [403, /Places API \(New\)/, false],
    [429, /quota/i, true],
    [400, /field mask/i, false],
    [503, /trouble/i, true],
  ];
  for (const [status, pattern, retryable] of cases) {
    await assert.rejects(
      () => searchPlaces('x', { apiKey: 'k', fetchImpl: placesReply({ error: { message: 'nope' } }, status) }),
      (err) => {
        assert.match(err.message, pattern, `HTTP ${status}`);
        assert.equal(err.retryable, retryable, `HTTP ${status} retryable`);
        return true;
      },
    );
  }
});

test('an unexpected response shape is reported, not returned empty', async () => {
  // If Google renames a field, every result arrives nameless and the prospect
  // list would silently stay empty. Same failure class as a stale field mapping.
  await assert.rejects(
    () => searchPlaces('x', {
      apiKey: 'k',
      fetchImpl: placesReply({ places: [{ id: 'a', title: 'Renamed Field Co' }] }),
    }),
    (err) => {
      assert.match(err.message, /not what this expects/);
      assert.match(err.message, /title/, 'lists the keys it actually got');
      return true;
    },
  );
});

test('a search that finds nothing is not an error', async () => {
  const result = await searchPlaces('asdkjhasd', { apiKey: 'k', fetchImpl: placesReply({}) });
  assert.deepEqual(result, { query: 'asdkjhasd', places: [], withoutWebsite: 0, searched: 0 });
});

test('paging stops at maxResults instead of draining the quota', async () => {
  let calls = 0;
  const result = await searchPlaces('q', {
    apiKey: 'k', maxResults: 3, pageSize: 2,
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({
        places: [onePlace({ id: `a${calls}` }), onePlace({ id: `b${calls}` })],
        nextPageToken: 'more',
      }) };
    },
  });
  assert.equal(result.searched, 4, 'the page that crossed the cap still counts');
  assert.ok(calls <= 2, `stopped paging promptly, made ${calls} requests`);
});

test('every buyer preset is usable and explains itself', () => {
  assert.ok(BUYER_PRESETS.length >= 5);
  for (const preset of BUYER_PRESETS) {
    assert.equal(getPreset(preset.id), preset);
    assert.ok(preset.query.length > 3, preset.id);
    assert.ok(preset.why.length > 20, `${preset.id} says why it is a buyer`);
  }
  assert.throws(() => getPreset('nope'), /Known:/);
});

// --- what an export should contain -------------------------------------

const prospect = (over) => ({ domain: 'x.com', name: 'X', emails: [], emailedAt: '', ...over });

test('one inbox is exported once, however many listings point at it', () => {
  // Places lists a firm under a product landing page and under its own site.
  // Different domains, one inbox -- and mailing that person twice is exactly
  // what the outreach log exists to prevent.
  const rows = exportable([
    prospect({ domain: 'cargovanbrooklyn.shop', name: 'Cargo Van', emails: ['info@rpk.com'] }),
    prospect({ domain: 'rpk.com', name: 'RPK', emails: ['info@rpk.com'] }),
    prospect({ domain: 'other.com', name: 'Other', emails: ['hi@other.com'] }),
  ]);
  assert.deepEqual(rows.map((r) => r.primary), ['info@rpk.com', 'hi@other.com']);
});

test('deduping is case-insensitive', () => {
  const rows = exportable([
    prospect({ domain: 'a.com', emails: ['Info@Firm.com'] }),
    prospect({ domain: 'b.com', emails: ['info@firm.com'] }),
  ]);
  assert.equal(rows.length, 1);
});

test('another company\'s addresses never reach the export', () => {
  // A broker's claims page lists the intake desk of every insurer they file
  // with. Pitching Chubb's claims queue is worse than sending nothing.
  const [row] = exportable([prospect({
    domain: 'levittfuirst.com',
    emails: ['info@levittfuirst.com', 'claims@levittfuirst.com', 'fnol@nationwide.com', 'cscfnol@chubb.com'],
  })]);
  assert.equal(row.primary, 'info@levittfuirst.com');
  assert.deepEqual(row.others, ['claims@levittfuirst.com'], 'only their own domain');
});

test('a primary address is kept even when it is off-domain', () => {
  // Small firms run on gmail, and that is still the address they read.
  const [row] = exportable([prospect({ domain: 'hdabk.com', emails: ['hdainsurancebk@gmail.com'] })]);
  assert.equal(row.primary, 'hdainsurancebk@gmail.com');
});

test('anyone already emailed, or with no address, is left out', () => {
  const rows = exportable([
    prospect({ domain: 'sent.com', emails: ['a@sent.com'], emailedAt: '2026-09-13T00:00:00Z' }),
    prospect({ domain: 'none.com', emails: [] }),
    prospect({ domain: 'new.com', emails: ['a@new.com'] }),
  ]);
  assert.deepEqual(rows.map((r) => r.domain), ['new.com']);
});

// --- composing the message ---------------------------------------------

import {
  buildBody, buildFollowUp, composeUrl, followUpSubject, formatRecords, greetingFor,
  isPersonAddress, SUBJECT,
} from './compose.mjs';

test('an address that belongs to a person gets their name', () => {
  assert.equal(greetingFor('kate@bestmarkinsurance.com'), 'Hi Kate,');
  assert.equal(greetingFor('patrick@championinsurance.org'), 'Hi Patrick,');
  assert.equal(greetingFor('john.smith@acme.com'), 'Hi John,', 'first.last uses the first');
});

test('anything that might not be a person stays generic', () => {
  // Greeting a firm as "Hi Hdainsurancebk," is worse than being generic, so
  // the rule is deliberately shy.
  for (const email of [
    'info@acig.insure', 'office@oaktree.com', 'claims@x.com', 'auto@ayroyal.com',
    'hdainsurancebk@gmail.com', 'dbjbins@gmail.com', 'friends.insurance@gmail.com',
    'mridgers@mkrspecialty.com', 'acquisitions@bbins.com', 'x@acme.com', '', null,
  ]) {
    assert.equal(greetingFor(email), 'Hi there,', String(email));
  }
});

test('the compose link opens Gmail, not a desktop mail app', () => {
  const url = new URL(composeUrl('kate@acme.com'));
  assert.equal(url.origin + url.pathname, 'https://mail.google.com/mail/');
  assert.equal(url.searchParams.get('view'), 'cm');
  assert.equal(url.searchParams.get('to'), 'kate@acme.com');
  assert.equal(url.searchParams.get('su'), SUBJECT);
  assert.match(url.searchParams.get('body'), /^Hi Kate,\n\nI keep an eye on/);
  // /u/0/ would be the wrong inbox for anyone whose Gmail is not the first
  // signed-in account.
  assert.ok(!url.pathname.includes('/u/'), 'no account number pinned');
});

test('composing needs an address', () => {
  assert.equal(composeUrl(''), '');
  assert.equal(composeUrl(null), '');
});

const SAMPLE_ROWS = [
  { name: 'Bread Winners Construction LLC', address: '2114 Birdsall Ave', borough: 'Queens', phone: '(347) 299-5161', date: '2026-08-18' },
  { name: 'S4M Construction Corp', address: '533 E 2nd St', borough: 'Brooklyn', phone: '(347) 458-8357', date: '2026-08-14' },
];

test('the businesses go in the body, because a compose URL cannot carry a file', () => {
  // Gmail has no attachment parameter -- any link could otherwise attach
  // arbitrary files -- and inline is the better mail anyway: nothing to
  // download from a stranger.
  const body = buildBody('kate@acme.com', SAMPLE_ROWS);
  assert.match(body, /Bread Winners Construction LLC {2}· {2}2114 Birdsall Ave, Queens {2}· {2}\(347\) 299-5161/);
  assert.match(body, /2 newly licensed contractors/);
});

test('the date range in the mail is the range of what is in it', () => {
  assert.match(buildBody('a@b.com', SAMPLE_ROWS), /from Aug 14–Aug 18/);
  assert.match(buildBody('a@b.com', [SAMPLE_ROWS[0]]), /from Aug 18 —/, 'one day reads as one day');
});

test('with no records the mail still works, and asks instead of showing', () => {
  // An empty store must not produce a mail promising a list that is not there.
  const body = buildBody('kate@acme.com', []);
  assert.match(body, /^Hi Kate,/);
  assert.match(body, /Want me to send you the latest\?/);
  assert.ok(!body.includes('Here\'s the most recent batch'), 'nothing is claimed that is not attached');
});

test('every mail carries a way out, whether or not it carries records', () => {
  // Required of commercial mail, and the cheaper of the two ways somebody
  // leaves: the other one is a spam complaint against the sending account.
  for (const records of [[], SAMPLE_ROWS]) {
    const body = buildBody('kate@acme.com', records);
    assert.match(body, /reply "no thanks"/, 'an opt-out in plain words');
    assert.ok(body.trimEnd().endsWith('that is the end of it.'), 'and it is the last thing read');
  }
});

test('the mail owns the publishing lag instead of implying there is none', () => {
  // DCWP runs about a month behind. Calling the list weekly while showing
  // five-week-old dates invites the reader to catch us; saying it outright
  // reads as knowing the data better than they do.
  const body = buildBody('kate@acme.com', SAMPLE_ROWS);
  assert.match(body, /about a month behind/);
  assert.ok(!body.includes("most won't have sorted it yet"), 'a claim the lag no longer supports');
});

test('the message says what it is before explaining itself', () => {
  // A pitch that opens by describing itself gets deleted; the goods come first
  // and there is no ask at the end.
  const body = buildBody('kate@acme.com', SAMPLE_ROWS);
  const listAt = body.indexOf('Bread Winners');
  assert.ok(listAt > 0 && listAt < body.indexOf('public DCWP data'), 'records before the explanation');
  assert.ok(!/\bbuy\b|\bprice\b|\$\d/.test(body), 'nothing is being sold yet');
});

test('a record missing a field does not leave a dangling separator', () => {
  const line = formatRecords([{ name: 'No Phone Co', address: '1 Main St', borough: 'Queens', phone: '' }]);
  assert.equal(line, 'No Phone Co  ·  1 Main St, Queens');
});

test('the compose URL carries the records', () => {
  const body = new URL(composeUrl('kate@acme.com', SAMPLE_ROWS)).searchParams.get('body');
  assert.match(body, /Bread Winners/);
  assert.ok(composeUrl('kate@acme.com', SAMPLE_ROWS).length < 8000, 'stays inside a usable URL length');
});

// --- who is behind an address ------------------------------------------

test('a named address is told apart from a desk', () => {
  // Decides who gets written to first, so it has to be right in both
  // directions: a missed person costs the best address on the list, and a
  // desk promoted to a person wastes the slot it took.
  for (const address of ['gene@agcommercialrisk.com', 'matt@dsragency.com', 'jen@csaninsurance.com', 'don@bentson.net']) {
    assert.equal(isPersonAddress(address), true, address);
  }
  for (const address of ['info@dcapinsurance.com', 'support@01insurance.com', 'claims@acme.com',
    'certs@cbli.net', 'coi@clausenagency.com', 'hdainsurancebk@gmail.com', '']) {
    assert.equal(isPersonAddress(address), false, address);
  }
});

test('the greeting and the person test never disagree', () => {
  // Both read the same address; a mail opening "Hi there," that was queued as
  // a named human means one of them is wrong.
  for (const address of ['kate@bestmarkinsurance.com', 'info@acme.com', 'quotes@acme.com', 'j@acme.com']) {
    assert.equal(greetingFor(address) !== 'Hi there,', isPersonAddress(address), address);
  }
});

// --- the second message ------------------------------------------------

test('the follow-up is short, greets the same way, and offers the way out', () => {
  const body = buildFollowUp('gene@agcommercialrisk.com');
  assert.match(body, /^Hi Gene,/);
  assert.match(body, /reply "no thanks"/);
  assert.ok(body.split('\n').length < 12, 'a nudge, not a second pitch');
});

test('the follow-up carries no records, because they would be the same ones', () => {
  // DCWP publishes about a month behind, so a follow-up days later would show
  // an identical list and point straight at the staleness.
  const body = buildFollowUp('kate@acme.com');
  assert.ok(!body.includes('·'), 'no record lines');
  assert.ok(!/most recent batch/.test(body));
});

test('"Re:" is used only where the message really threads', () => {
  // Faking a reply to a message nobody sent is the oldest trick in cold mail,
  // and it costs the trust every other line is trying to earn.
  assert.equal(followUpSubject('<abc@gmail.com>'), `Re: ${SUBJECT}`);
  assert.ok(!followUpSubject('').startsWith('Re:'), 'nothing to thread onto');
  assert.ok(!followUpSubject(undefined).startsWith('Re:'), 'and none recorded at all');
});
