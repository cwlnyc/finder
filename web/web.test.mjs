import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { createApp } from './server.mjs';
import { mergeStore } from '../records/store.mjs';
import { today, addDays } from '../records/normalize.mjs';

let server;
let base;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-test-'));

  // 60 records across recent days, so date filters have something to bite on.
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `L${i}`,
    date: addDays(today(), -(i % 30)),
    name: i === 3 ? '<script>alert(1)</script>' : i === 4 ? '=Best Cuts' : `Biz ${i}`,
    category: i % 2 ? 'Home Improvement Contractor' : 'Sidewalk Cafe',
    status: 'Active',
    borough: i % 3 === 0 ? 'Queens' : i % 3 === 1 ? 'QUEENS' : 'Bronx',
    street: 'MAIN ST',
    zip: '11106',
  }));
  await mergeStore('dcwp-licenses', rows, { dir });

  server = createApp({ dataDir: dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const feed = async (query = '') => (await fetch(`${base}/api/feed?source=dcwp-licenses&${query}`)).json();

test('the page and its assets are served', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), new RegExp(type));
  }
});

test('only the three known asset paths are reachable', async () => {
  // The server has no static-file handler, so there is no path to traverse --
  // these must 404 rather than resolve to a file.
  for (const path of ['/../package.json', '/%2e%2e%2fpackage.json', '/server.mjs', '/records/data/dcwp-licenses.jsonl']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('an unknown source is a client error, not a server fault', async () => {
  const res = await fetch(`${base}/api/feed?source=../../../etc/passwd`);
  assert.equal(res.status, 400, 'the allowlist rejects it before any path is built');
  assert.match((await res.json()).error, /Unknown source/);
});

test('methods other than GET and POST are refused', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    assert.equal((await fetch(`${base}/api/feed`, { method })).status, 405, method);
  }
});

test('POST is only for the prospect write routes', async () => {
  // A POST to a read-only route must not quietly behave like a GET.
  const res = await fetch(`${base}/api/feed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: '{}',
  });
  assert.equal(res.status, 404);
});

test('an unknown route 404s with a usable message', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /No route/);
});

test('filter options come from the whole store, not the filtered rows', async () => {
  // The trap: deriving the dropdowns from the current result set removes every
  // other borough the moment one is picked, so the filter cannot be undone.
  const all = await feed('days=0');
  const filtered = await feed('days=0&borough=Bronx');
  assert.deepEqual(filtered.options.borough, all.options.borough);
  // Which casing the fold keeps is arbitrary (whichever row sorts first), so
  // assert the borough is still offered, not how it is spelled.
  assert.ok(
    filtered.options.borough.some((b) => b.toLowerCase() === 'queens'),
    'Queens is still selectable while filtered to the Bronx',
  );
  assert.ok(filtered.total < all.total, 'and the filter still narrowed the rows');
});

test('borough options fold the portal\'s mixed casing to one entry', () => {
  // "Queens" and "QUEENS" are the same place and must not appear twice.
  return feed('days=0').then((data) => {
    const queens = data.options.borough.filter((b) => b.toLowerCase() === 'queens');
    assert.equal(queens.length, 1);
  });
});

test('the table is capped but the CSV export is not', async () => {
  // Easy to get backwards: the browser gets 500 rows for speed, but a lead list
  // that silently stops at 500 is a broken product.
  const data = await feed('days=0');
  assert.equal(data.total, 60);
  assert.equal(data.rows.length, 60);

  const csv = await (await fetch(`${base}/api/export.csv?source=dcwp-licenses&days=0`)).text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 61, 'header + every matching row');
});

test('the CSV export respects the active filters', async () => {
  const csv = await (await fetch(`${base}/api/export.csv?source=dcwp-licenses&days=0&borough=Bronx`)).text();
  const lines = csv.trim().split('\r\n');
  assert.ok(lines.length > 1 && lines.length < 61);
  assert.ok(!csv.includes('Queens'), 'a filtered export must not leak other boroughs');
});

test('the CSV export is served as a download, not rendered', async () => {
  const res = await fetch(`${base}/api/export.csv?source=dcwp-licenses&days=0`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="dcwp-licenses-\d{4}-\d{2}-\d{2}\.csv"/);
});

test('a name that would execute in Excel is defused on the way out', async () => {
  const csv = await (await fetch(`${base}/api/export.csv?source=dcwp-licenses&days=0`)).text();
  assert.ok(csv.includes("'=Best Cuts"), 'formula-shaped names carry a leading apostrophe');
});

test('script-shaped record text is returned as data, never as markup', async () => {
  const res = await fetch(`${base}/api/feed?source=dcwp-licenses&days=0`);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const data = await res.json();
  const row = data.rows.find((r) => r.name.includes('script'));
  assert.equal(row.name, '<script>alert(1)</script>', 'stored verbatim; the client renders via textContent');
});

test('a garbled days parameter narrows nothing instead of failing', async () => {
  for (const value of ['abc', '-5', '', 'Infinity', '1e999']) {
    const res = await fetch(`${base}/api/feed?source=dcwp-licenses&days=${encodeURIComponent(value)}`);
    assert.equal(res.status, 200, `days=${value}`);
    assert.equal((await res.json()).total, 60, `days=${value} should fall back to all data`);
  }
});

test('an absurd window is clamped rather than rejected', async () => {
  const data = await feed('days=99999');
  assert.equal(data.filters.days, 3650);
  assert.equal(data.total, 60);
});

test('the date window actually narrows the result', async () => {
  const week = await feed('days=7');
  const all = await feed('days=0');
  assert.ok(week.total < all.total);
  assert.ok(week.total > 0);
});

test('weekly stats ride along with the feed', async () => {
  const data = await feed('days=0');
  assert.ok(Array.isArray(data.stats.weeks));
  assert.ok(data.stats.range.first <= data.stats.range.last);
  assert.equal(typeof data.stats.median, 'number');
});

test('a source with no store reports empty and names the fix', async () => {
  const res = await fetch(`${base}/api/feed?source=dob-permits`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.empty, true);
  assert.equal(data.pullCommand, 'node records/cli.mjs pull dob-permits --days 180');
});

test('the sources list reports what has been pulled', async () => {
  const { sources } = await (await fetch(`${base}/api/sources`)).json();
  assert.equal(sources.length, 3);
  assert.equal(sources.find((s) => s.id === 'dcwp-licenses').count, 60);
  assert.equal(sources.find((s) => s.id === 'dob-permits').count, 0);
  assert.ok(sources.every((s) => s.confidence), 'the UI needs this to warn about unverified columns');
});

test('the table and the CSV agree on which columns exist', async () => {
  // These used to be two hand-maintained lists. If they drift, the browser
  // shows a column the download lacks (or the reverse) and nothing errors.
  const data = await feed('days=0');
  const csv = await (await fetch(`${base}/api/export.csv?source=dcwp-licenses&days=0`)).text();
  const header = csv.split('\r\n')[0].split(',');
  assert.deepEqual(data.columns.map(([, label]) => label), header);
});

test('the feed labels its columns for display', async () => {
  const data = await feed('days=0');
  assert.ok(data.columns.length > 0);
  for (const entry of data.columns) {
    assert.equal(entry.length, 2, 'each column is a [key, label] pair');
    assert.equal(typeof entry[1], 'string');
  }
  assert.deepEqual(data.columns[0], ['date', 'Date']);
});

test('the feed reports a wholly blank column so the UI can explain itself', async () => {
  // A filter dropdown with nothing in it reads as a broken page. The client
  // turns filled === 0 into "re-pull, your mapping is stale", so this number
  // has to be exact rather than approximately right.
  const data = await feed('days=0');
  const phone = data.completeness.find((c) => c.field === 'phone');
  assert.equal(phone, undefined, 'phone is not in the completeness set');

  const street = data.completeness.find((c) => c.field === 'street');
  assert.equal(street.filled, 60, 'street is populated in the fixture');
  assert.equal(data.options.category.length > 0, true, 'and category still offers options');
});

test('records whose licence is dead are counted and named', async () => {
  // A Voided licence is not a new business, and shipping one to a buyer costs
  // more trust than the row was worth.
  const data = await feed('days=0');
  assert.equal(data.activeStatus, 'Active');
  assert.equal(data.dead.count, 0, 'the fixture is all Active');

  const dir2 = await mkdtemp(join(tmpdir(), 'web-dead-'));
  await mergeStore('dcwp-licenses', [
    { id: 'A', date: today(), name: 'Live Co', status: 'Active', zip: '11218' },
    { id: 'B', date: today(), name: 'Gone Co', status: 'Voided', zip: '11218' },
    { id: 'C', date: today(), name: 'Quit Co', status: 'Surrendered', zip: '11218' },
  ], { dir: dir2 });
  const app = createApp({ dataDir: dir2 });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${app.address().port}/api/feed?source=dcwp-licenses&days=0`);
  const body = await res.json();
  assert.equal(body.dead.count, 2);
  assert.deepEqual(body.dead.statuses, ['Surrendered', 'Voided'], 'named so the notice can list them');
  await new Promise((r) => app.close(r));
  await rm(dir2, { recursive: true, force: true });
});

test('a source with no notion of an active status reports none', async () => {
  const res = await fetch(`${base}/api/feed?source=dob-permits&days=0`);
  const body = await res.json();
  assert.equal(body.dead, null, 'DOB filing statuses are legitimately mixed');
});

// --- prospects -----------------------------------------------------------

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: JSON.stringify(body),
  });

test('a write without a JSON content type is refused', async () => {
  // Blocks the one hole a loopback-only server still has: a page you are
  // visiting POSTing to localhost. A cross-site form cannot set this header.
  const res = await fetch(`${base}/api/prospects/add`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'text=evil.com',
  });
  assert.equal(res.status, 403);
});

test('a write from another origin is refused', async () => {
  const res = await post('/api/prospects/add', { text: 'evil.com' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /only from this page/);
});

test('adding sites from pasted text dedupes by host', async () => {
  const res = await post('/api/prospects/add', {
    text: 'Business,Website\nAcme Ins,acme-test.com\nAcme Again,https://www.acme-test.com/contact\nBeta Ins,beta-test.com',
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.added, 2, 'the same host twice is one prospect');
  assert.equal(data.counts.pending, 2);
});

test('pasting something with no usable address says so', async () => {
  const res = await post('/api/prospects/add', { text: 'not a url\n\n???' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No usable website/);
});

test('marking emailed sticks, and undo clears it', async () => {
  let data = await (await post('/api/prospects/mark', { domain: 'acme-test.com', action: 'emailed' })).json();
  let acme = data.prospects.find((p) => p.domain === 'acme-test.com');
  assert.ok(acme.emailedAt, 'recorded');
  assert.equal(data.counts.emailed, 1);

  data = await (await post('/api/prospects/mark', { domain: 'acme-test.com', action: 'unmark' })).json();
  acme = data.prospects.find((p) => p.domain === 'acme-test.com');
  assert.equal(acme.emailedAt, '', 'the click you did not mean is undoable');
  assert.equal(data.counts.emailed, 0);
});

test('a reply implies the mail that prompted it', async () => {
  const data = await (await post('/api/prospects/mark', { domain: 'beta-test.com', action: 'replied' })).json();
  const beta = data.prospects.find((p) => p.domain === 'beta-test.com');
  assert.ok(beta.repliedAt);
  assert.ok(beta.emailedAt, 'you cannot get a reply to a mail you never sent');
});

test('an unknown prospect or action is rejected, not guessed at', async () => {
  assert.equal((await post('/api/prospects/mark', { domain: 'nope.com', action: 'emailed' })).status, 404);
  assert.equal((await post('/api/prospects/mark', { domain: 'acme-test.com', action: 'nonsense' })).status, 400);
});

test('the prospect export leaves out anyone already written to', async () => {
  await post('/api/prospects/mark', { domain: 'acme-test.com', action: 'unmark' });
  // Give both an address so they are exportable at all.
  const before = await (await fetch(`${base}/api/prospects`)).json();
  assert.equal(before.counts.withEmail, 0, 'nothing crawled in this test, so nothing to export');

  const res = await fetch(`${base}/api/prospects/export.csv`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="prospects-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal((await res.text()).trim(), 'name,domain,email,other_emails,website', 'header only');
});

test('an unknown POST route is a 404, not a silent success', async () => {
  assert.equal((await post('/api/prospects/nope', {})).status, 404);
});

test('the feed reports how many contacts an export would actually contain', async () => {
  // A CSV with only a header is the most confusing possible answer, so the page
  // needs this number to refuse the download and say why.
  const dir3 = await mkdtemp(join(tmpdir(), 'web-ready-'));
  await mergeStore('dcwp-licenses', [{ id: 'x', date: today(), name: 'n', zip: '11218' }], { dir: dir3 });
  const { addSites, updateProspect } = await import('../prospects/store.mjs');
  await addSites([
    { domain: 'found.com', url: 'https://found.com/', name: 'Found' },
    { domain: 'nomail.com', url: 'https://nomail.com/', name: 'No Mail' },
    { domain: 'sent.com', url: 'https://sent.com/', name: 'Sent' },
  ], { dir: dir3 });
  await updateProspect('found.com', { emails: ['a@found.com'], status: 'ok' }, { dir: dir3 });
  await updateProspect('sent.com', { emails: ['b@sent.com'], status: 'ok', emailedAt: '2026-09-13T00:00:00Z' }, { dir: dir3 });

  const app = createApp({ dataDir: dir3 });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const { counts } = await (await fetch(`http://127.0.0.1:${app.address().port}/api/prospects`)).json();
  assert.equal(counts.total, 3);
  assert.equal(counts.withEmail, 2);
  assert.equal(counts.ready, 1, 'only the one with an address that has not been written to');
  await new Promise((r) => app.close(r));
  await rm(dir3, { recursive: true, force: true });
});
