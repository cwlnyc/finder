// Local web UI for the records feed. No dependencies, no framework.
//
// Binds to 127.0.0.1 only. The store holds contact-adjacent business data and
// this has no authentication, so it must not be reachable from the LAN; 0.0.0.0
// would publish it to every device on the network.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCES, getSource } from '../records/sources.mjs';
import { readStore, storePath } from '../records/store.mjs';
import { completeness, csvCell, filterRows, presentColumns, presentRows, sliceBreakdown, toCsv, weeklyStats } from '../records/digest.mjs';
import { addDays, today } from '../records/normalize.mjs';
import { crawlSite } from '../prospects/crawl.mjs';
import { parseSiteFile } from '../prospects/input.mjs';
import { addSites, readProspects, updateProspect, writeProspects } from '../prospects/store.mjs';
import { BUYER_PRESETS, PlacesError, searchPlaces } from '../prospects/places.mjs';
import { normalizeUrl, siteDomain } from '../prospects/crawl.mjs';

const WEB_DIR = dirname(fileURLToPath(import.meta.url));

// An explicit allowlist rather than a static-file handler: there is no path to
// join user input onto, so directory traversal is not a class of bug here.
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const MAX_ROWS = 500; // what the table renders; CSV export is unlimited

// How many sites one "look up" click crawls. Each takes a couple of seconds by
// design, so a bigger batch would sit past the browser's patience with nothing
// to show for it. Click again for the next batch.
const FIND_BATCH = 5;
const MAX_BODY = 1_000_000;

// Re-reading the JSONL on every keystroke gets expensive once a store is large,
// so cache per source and invalidate on mtime.
const cache = new Map();
async function loadStore(sourceId, dataDir) {
  const path = dataDir ? storePath(sourceId, dataDir) : storePath(sourceId);
  if (!existsSync(path)) return [];
  const { mtimeMs } = await stat(path);
  const key = `${dataDir ?? ''}::${sourceId}`;
  const hit = cache.get(key);
  if (hit?.mtimeMs === mtimeMs) return hit.rows;
  const rows = dataDir ? await readStore(sourceId, dataDir) : await readStore(sourceId);
  cache.set(key, { mtimeMs, rows });
  return rows;
}

/**
 * Accept a write only from this page.
 *
 * The server has no authentication because it is loopback-only, which still
 * leaves one hole: any website you happen to be visiting can POST to
 * localhost. Requiring a same-origin Origin header and a JSON content type
 * closes it -- a cross-site form post cannot set either.
 */
function writeAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).hostname;
    } catch {
      return false;
    }
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  }
  return /^application\/json\b/.test(req.headers['content-type'] ?? '');
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Read filters off the query string, treating blanks as absent. */
function readFilters(params) {
  const pick = (key) => {
    const value = params.get(key);
    return value && value.trim() !== '' ? value.trim() : undefined;
  };
  const rawDays = Number(params.get('days'));
  // Clamp rather than reject: a hand-edited URL should narrow the view, not 500.
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 3650) : 0;

  return {
    days,
    since: days ? addDays(today(), -days) : undefined,
    borough: pick('borough'),
    category: pick('category'),
    status: pick('status'),
    contains: pick('contains'),
  };
}

function uniqueValues(rows, key) {
  const seen = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    // The portal mixes "Queens" and "QUEENS"; collapse them but show the
    // readable form.
    const fold = value.toLowerCase();
    if (!seen.has(fold)) seen.set(fold, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

async function handleSources(res, dataDir) {
  const list = await Promise.all(
    SOURCES.map(async (source) => {
      const rows = await loadStore(source.id, dataDir);
      return {
        id: source.id,
        label: source.label,
        why: source.why,
        dataset: source.dataset,
        confidence: source.confidence,
        count: rows.length,
      };
    }),
  );
  json(res, 200, { sources: list });
}

async function buildFeed(params, dataDir) {
  // getSource throws on anything not in the allowlist, which is also what keeps
  // a crafted ?source= from reaching the filesystem via storePath().
  const source = getSource(params.get('source') ?? SOURCES[1].id);
  const all = await loadStore(source.id, dataDir);
  const filters = readFilters(params);
  const rows = filterRows(all, filters).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
  return { source, all, rows, filters };
}

/** Records whose licence is no longer live, for sources that define one. */
function deadRecords(source, rows) {
  if (!source.activeStatus) return null;
  const dead = rows.filter((r) => r.status && r.status !== source.activeStatus);
  return { count: dead.length, statuses: [...new Set(dead.map((r) => r.status))].sort() };
}

async function handleFeed(res, params, dataDir) {
  const { source, all, rows, filters } = await buildFeed(params, dataDir);
  const stats = weeklyStats(rows);
  // Filtering and the statistics run on raw values; only what reaches a human
  // gets cleaned up.
  const shown = presentRows(rows.slice(0, MAX_ROWS));

  json(res, 200, {
    source: { id: source.id, label: source.label, dataset: source.dataset, confidence: source.confidence },
    empty: all.length === 0,
    dead: deadRecords(source, rows),
    activeStatus: source.activeStatus ?? null,
    pullCommand: `node records/cli.mjs pull ${source.id} --days 180`,
    total: rows.length,
    truncated: rows.length > MAX_ROWS,
    rows: shown,
    // The client renders whatever columns the server says are populated, so the
    // table and the CSV can never disagree about a source's shape.
    columns: presentColumns(shown),
    stats: {
      median: stats.median,
      mean: stats.mean,
      weeks: stats.completeWeeks,
      range: stats.range,
      dated: stats.dated,
      undated: stats.total - stats.dated,
    },
    // Per-week rate for every category and borough, so a sellable slice can be
    // spotted from one screen instead of filtering to each one by hand.
    slices: {
      category: sliceBreakdown(rows, 'category').slice(0, 25),
      borough: sliceBreakdown(rows, 'borough').slice(0, 25),
    },
    completeness: completeness(rows, ['name', 'category', 'borough', 'street', 'zip', 'status']),
    // Options come from the UNFILTERED store: deriving them from the filtered
    // rows would delete every other borough from the list the moment one is
    // picked, leaving no way back.
    options: {
      borough: uniqueValues(all, 'borough'),
      category: uniqueValues(all, 'category'),
      status: uniqueValues(all, 'status'),
    },
    filters: { ...filters, since: filters.since ?? null },
  });
}

async function handleExport(res, params, dataDir) {
  const { source, rows } = await buildFeed(params, dataDir);
  const presented = presentRows(rows);
  const csv = toCsv(presented, presentColumns(presented));
  const filename = `${source.id}-${today()}.csv`;

  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(csv),
  });
  res.end(csv);
}

// --- prospects ---------------------------------------------------------

function prospectSummary(rows) {
  return {
    prospects: rows,
    counts: {
      total: rows.length,
      pending: rows.filter((p) => p.status === 'pending').length,
      withEmail: rows.filter((p) => p.emails.length > 0).length,
      emailed: rows.filter((p) => p.emailedAt).length,
      replied: rows.filter((p) => p.repliedAt).length,
      // What the export would actually contain: has an address, not yet written
      // to. Without this the page cannot say why a download would be empty.
      ready: rows.filter((p) => p.emails.length > 0 && !p.emailedAt).length,
    },
  };
}

async function handleProspects(res, dataDir) {
  json(res, 200, {
    ...prospectSummary(await readProspects(dataDir)),
    buyers: BUYER_PRESETS,
    // The key itself never leaves the server; the page only needs to know
    // whether searching is possible so it can say what to do when it is not.
    searchReady: Boolean(process.env.GOOGLE_PLACES_API_KEY),
  });
}

async function handleProspectSearch(res, body, dataDir) {
  const preset = BUYER_PRESETS.find((p) => p.id === body.buyer);
  const term = preset ? preset.query : String(body.query ?? '').trim();
  const area = String(body.area ?? '').trim();
  if (!term) {
    json(res, 400, { error: 'Nothing to search for. Pick a buyer or type what to look for.' });
    return;
  }

  let result;
  try {
    result = await searchPlaces([term, area].filter(Boolean).join(' '), { maxResults: 40 });
  } catch (err) {
    // A Places failure is the caller's to fix (key, quota, query) -- report it
    // as such rather than as a broken server.
    json(res, err instanceof PlacesError ? 400 : 500, { error: err.message });
    return;
  }

  const sites = [];
  for (const place of result.places) {
    const url = normalizeUrl(place.website);
    const domain = siteDomain(url);
    if (domain) sites.push({ url, domain, name: place.name });
  }
  const added = await addSites(sites, { dir: dataDir });

  json(res, 200, {
    searched: result.searched,
    withoutWebsite: result.withoutWebsite,
    added: added.added,
    skipped: added.skipped,
    ...prospectSummary(await readProspects(dataDir)),
  });
}

async function handleProspectAdd(res, body, dataDir) {
  const sites = parseSiteFile(String(body.text ?? ''));
  if (sites.length === 0) {
    json(res, 400, { error: 'No usable website addresses in that. One URL per line, or paste a CSV with a website column.' });
    return;
  }
  const result = await addSites(sites, { dir: dataDir });
  json(res, 200, { ...result, ...prospectSummary(await readProspects(dataDir)) });
}

async function handleProspectMark(res, body, dataDir) {
  const now = new Date().toISOString();
  const changes = {
    emailed: { emailedAt: now },
    replied: { repliedAt: now, emailedAt: now },
    skip: { status: 'skip' },
    // Undo, for the click you did not mean.
    unmark: { emailedAt: '', repliedAt: '' },
  }[body.action];
  if (!changes) {
    json(res, 400, { error: `Unknown action '${body.action}'` });
    return;
  }
  try {
    await updateProspect(String(body.domain ?? ''), changes, { dir: dataDir });
  } catch (err) {
    json(res, 404, { error: err.message });
    return;
  }
  json(res, 200, prospectSummary(await readProspects(dataDir)));
}

async function handleProspectFind(res, dataDir) {
  const all = await readProspects(dataDir);
  const queue = all.filter((p) => p.status === 'pending').slice(0, FIND_BATCH);
  for (const prospect of queue) {
    const result = await crawlSite(prospect.url);
    prospect.status = result.status;
    prospect.emails = result.emails.map((e) => e.email);
    prospect.crawledAt = new Date().toISOString();
    prospect.notes = result.error || '';
  }
  await writeProspects(all, dataDir);
  json(res, 200, { crawled: queue.length, ...prospectSummary(await readProspects(dataDir)) });
}

async function handleProspectExport(res, dataDir) {
  const rows = (await readProspects(dataDir)).filter((p) => p.emails.length > 0 && !p.emailedAt);
  const cols = ['name', 'domain', 'email', 'other_emails', 'website'];
  const lines = [cols.join(',')];
  for (const p of rows) {
    lines.push([p.name, p.domain, p.emails[0], p.emails.slice(1).join(' '), p.url].map(csvCell).join(','));
  }
  const csv = lines.join('\r\n') + '\r\n';
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="prospects-${today()}.csv"`,
    'content-length': Buffer.byteLength(csv),
  });
  res.end(csv);
}

async function handleAsset(res, pathname) {
  const [file, type] = ASSETS[pathname];
  const body = await readFile(join(WEB_DIR, file));
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

// `dataDir` exists so tests can point at a fixture store instead of the real
// one; production leaves it undefined and the store uses its own default.
export function createApp({ dataDir } = {}) {
  return createServer(async (req, res) => {
    // The Host header is untrusted; only the path and query matter here.
    const url = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'POST') {
        if (!writeAllowed(req)) {
          json(res, 403, { error: 'Writes are accepted only from this page.' });
          return;
        }
        const body = await readJsonBody(req);
        if (url.pathname === '/api/prospects/add') return await handleProspectAdd(res, body, dataDir);
        if (url.pathname === '/api/prospects/search') return await handleProspectSearch(res, body, dataDir);
        if (url.pathname === '/api/prospects/mark') return await handleProspectMark(res, body, dataDir);
        if (url.pathname === '/api/prospects/find') return await handleProspectFind(res, dataDir);
        json(res, 404, { error: `No route for ${url.pathname}` });
        return;
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'Only GET and POST are supported' });
        return;
      }
      if (ASSETS[url.pathname]) return await handleAsset(res, url.pathname);
      if (url.pathname === '/api/sources') return await handleSources(res, dataDir);
      if (url.pathname === '/api/feed') return await handleFeed(res, url.searchParams, dataDir);
      if (url.pathname === '/api/export.csv') return await handleExport(res, url.searchParams, dataDir);
      if (url.pathname === '/api/prospects') return await handleProspects(res, dataDir);
      if (url.pathname === '/api/prospects/export.csv') return await handleProspectExport(res, dataDir);
      json(res, 404, { error: `No route for ${url.pathname}` });
    } catch (err) {
      // An unknown ?source= is the caller's mistake, not a server fault.
      const bad = /^Unknown source/.test(err.message);
      json(res, bad ? 400 : 500, { error: err.message });
    }
  });
}

export function start({ port = 4000, host = '127.0.0.1' } = {}) {
  const server = createApp();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${port} is already in use. Try:  npm run web -- --port ${port + 1}`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    console.log(`\n  Records feed  ->  http://localhost:${port}\n`);
    const empty = SOURCES.filter((s) => !existsSync(storePath(s.id)));
    if (empty.length === SOURCES.length) {
      console.log('  No data pulled yet. In another terminal:');
      console.log('    node records/cli.mjs probe --all');
      console.log(`    node records/cli.mjs pull ${SOURCES[1].id} --days 180\n`);
    }
    console.log('  Ctrl-C to stop\n');
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--port');
  start({ port: i !== -1 ? Number(process.argv[i + 1]) : Number(process.env.PORT) || 4000 });
}
