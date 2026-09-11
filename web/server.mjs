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
import { breakdown, completeness, filterRows, toCsv, weeklyStats } from '../records/digest.mjs';
import { addDays, today } from '../records/normalize.mjs';

const WEB_DIR = dirname(fileURLToPath(import.meta.url));

// An explicit allowlist rather than a static-file handler: there is no path to
// join user input onto, so directory traversal is not a class of bug here.
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const MAX_ROWS = 500; // what the table renders; CSV export is unlimited

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

async function handleFeed(res, params, dataDir) {
  const { source, all, rows, filters } = await buildFeed(params, dataDir);
  const stats = weeklyStats(rows);

  json(res, 200, {
    source: { id: source.id, label: source.label, dataset: source.dataset, confidence: source.confidence },
    empty: all.length === 0,
    pullCommand: `node records/cli.mjs pull ${source.id} --days 180`,
    total: rows.length,
    truncated: rows.length > MAX_ROWS,
    rows: rows.slice(0, MAX_ROWS),
    stats: {
      median: stats.median,
      mean: stats.mean,
      weeks: stats.completeWeeks,
      range: stats.range,
      dated: stats.dated,
      undated: stats.total - stats.dated,
    },
    breakdown: breakdown(rows),
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
  const columns = ['date', 'name', 'dba', 'category', 'status', 'borough', 'street', 'zip', 'id'].filter(
    (c) => rows.some((r) => r[c] !== '' && r[c] != null),
  );
  const csv = toCsv(rows, columns);
  const filename = `${source.id}-${today()}.csv`;

  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
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
      if (req.method !== 'GET') {
        json(res, 405, { error: 'Only GET is supported' });
        return;
      }
      if (ASSETS[url.pathname]) return await handleAsset(res, url.pathname);
      if (url.pathname === '/api/sources') return await handleSources(res, dataDir);
      if (url.pathname === '/api/feed') return await handleFeed(res, url.searchParams, dataDir);
      if (url.pathname === '/api/export.csv') return await handleExport(res, url.searchParams, dataDir);
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
