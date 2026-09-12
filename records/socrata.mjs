// Socrata (Open Data portal) client.

import { parseDay } from './normalize.mjs';

const PAGE_SIZE = 1000;

// Canonical fields carrying a calendar date. Listed explicitly rather than
// sniffed: a text column that merely looks like a date must not be rewritten.
const DATE_FIELDS = new Set(['date', 'expires']);

export class MappingError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MappingError';
    this.details = details;
  }
}

export function buildUrl(source, { since, limit = PAGE_SIZE, offset = 0, order = true } = {}) {
  const url = new URL(`https://${source.domain}/resource/${source.dataset}.json`);
  url.searchParams.set('$limit', String(limit));
  if (offset) url.searchParams.set('$offset', String(offset));
  if (since) {
    // SoQL floating-timestamp literal: no Z, or the portal rejects the compare.
    url.searchParams.set('$where', `${source.dateField} >= '${since}T00:00:00'`);
  }
  if (order) {
    // Paging with $offset and no $order is undefined: the portal may return
    // rows in a different order per page, so rows get skipped and others
    // duplicated with no error anywhere. `:id` is Socrata's system row key --
    // present on every dataset, unique, and stable across pages.
    url.searchParams.set('$order', ':id');
  }
  return url.toString();
}

async function getJson(url, { fetchImpl = fetch, appToken = process.env.SOCRATA_APP_TOKEN } = {}) {
  const headers = { Accept: 'application/json' };
  if (appToken) headers['X-App-Token'] = appToken;

  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 429
        ? ' (rate limited -- set SOCRATA_APP_TOKEN, a free token lifts the anonymous cap)'
        : res.status === 400
          ? ' (usually a bad column name in $where/$order -- run `probe`)'
          : '';
    throw new Error(`${url} -> HTTP ${res.status}${hint}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

/**
 * Sample real rows and report, per column, whether it exists AND how often it
 * actually carries a value.
 *
 * Existence alone is not enough. A column can be present in the schema and
 * empty in every row -- the pull then succeeds, the store fills with blanks,
 * and the only symptom is a filter with nothing in it. That is a slower, more
 * confusing failure than a name that is simply wrong, so measure the fill rate
 * rather than trusting the column list.
 */
export async function probeSource(source, { sampleSize = 200, ...opts } = {}) {
  // No $order: :id is valid everywhere, but if the caller's mapping is broken
  // we want the request itself to succeed so we can report the real columns.
  const rows = await getJson(buildUrl(source, { limit: sampleSize, order: false }), opts);

  // Socrata omits null fields from each row entirely, so a column missing from
  // one row may be populated in the next. Union the keys across the sample.
  const actual = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();

  const filled = (column) =>
    rows.filter((r) => r[column] != null && String(r[column]).trim() !== '').length;
  const example = (column) => {
    const hit = rows.find((r) => r[column] != null && String(r[column]).trim() !== '');
    return hit ? String(hit[column]).trim().slice(0, 38) : '';
  };
  const pct = (n) => (rows.length ? Math.round((n / rows.length) * 100) : 0);

  const declared = Object.entries(source.fields);
  const results = declared.map(([canonical, column]) => ({
    canonical,
    column,
    ok: actual.includes(column),
    pct: pct(filled(column)),
    example: example(column),
    required: source.required.includes(canonical),
  }));

  const unmapped = actual
    .filter((c) => !declared.some(([, col]) => col === c))
    .map((column) => ({ column, pct: pct(filled(column)), example: example(column) }))
    .sort((a, b) => b.pct - a.pct);

  return {
    source,
    sampled: rows.length,
    actual,
    results,
    unmapped,
    dateOk: actual.includes(source.dateField),
    row: rows[0] ?? null,
  };
}

export function normalizeRow(source, raw) {
  const out = {};
  for (const [canonical, column] of Object.entries(source.fields)) {
    const value = raw[column];
    out[canonical] = value == null ? '' : String(value).trim();
  }
  // Collapse the portal's timestamps to calendar days at the one boundary where
  // raw data enters the system. Everything downstream -- week bucketing, range
  // filters, the store's sort -- assumes a bare 'YYYY-MM-DD' and goes quietly
  // wrong on '2026-09-07T00:00:00.000' rather than failing.
  for (const field of DATE_FIELDS) {
    if (field in out) out[field] = parseDay(out[field]) ?? '';
  }
  return out;
}

/**
 * Refuse a batch whose required fields came back empty.
 *
 * This is the guard for the thing that otherwise fails silently: a renamed
 * column makes every lookup return undefined, so the pull "succeeds" and
 * writes thousands of blank rows over good data. Checked per batch, before
 * anything touches disk.
 */
export function assertMapping(source, rows, { threshold = 0.5 } = {}) {
  if (rows.length === 0) return;

  const complete = rows.filter((r) => source.required.every((f) => r[f] !== '')).length;
  const ratio = complete / rows.length;
  if (ratio >= threshold) return;

  const blankest = source.required
    .map((f) => ({ field: f, column: source.fields[f], blank: rows.filter((r) => r[f] === '').length }))
    .filter((f) => f.blank > 0)
    .sort((a, b) => b.blank - a.blank);

  throw new MappingError(
    `Field mapping for '${source.id}' looks stale: only ${complete}/${rows.length} rows ` +
      `have all required fields.\n` +
      blankest.map((f) => `  ${f.field} <- '${f.column}' blank in ${f.blank} rows`).join('\n') +
      `\n\nNothing was written. Run:\n  node records/cli.mjs probe ${source.id}\n` +
      `then correct the column names in records/sources.mjs.`,
    { blankest },
  );
}

/** Page through every matching row, newest-safe and duplicate-free. */
export async function fetchRows(source, { since, max = Infinity, onPage, ...opts } = {}) {
  const rows = [];
  for (let offset = 0; rows.length < max; offset += PAGE_SIZE) {
    const url = buildUrl(source, { since, limit: PAGE_SIZE, offset });
    const page = await getJson(url, opts);
    if (page.length === 0) break;

    const normalized = page.map((raw) => normalizeRow(source, raw));
    assertMapping(source, normalized);
    rows.push(...normalized);
    onPage?.({ offset, received: page.length, total: rows.length });

    if (page.length < PAGE_SIZE) break;
  }
  return rows.slice(0, max === Infinity ? undefined : max);
}
