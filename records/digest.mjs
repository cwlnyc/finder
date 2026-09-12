// Filtering, volume statistics, and output rendering.

import { addDays, compareDay, daysBetween, weekStart } from './normalize.mjs';

export function filterRows(rows, { since, until, borough, category, status, contains } = {}) {
  const norm = (s) => String(s ?? '').toLowerCase();
  const boroughs = borough ? [borough].flat().map(norm) : null;

  return rows.filter((r) => {
    if (!r.date) return false;
    if (since && compareDay(r.date, since) < 0) return false;
    if (until && compareDay(r.date, until) > 0) return false;
    if (boroughs && !boroughs.includes(norm(r.borough))) return false;
    // Substring, not equality: "Home Improvement" should match
    // "Home Improvement Contractor" and "Home Improvement Salesperson".
    if (category && !norm(r.category).includes(norm(category))) return false;
    if (status && norm(r.status) !== norm(status)) return false;
    if (contains) {
      const hay = norm([r.name, r.dba, r.category, r.street].join(' '));
      if (!hay.includes(norm(contains))) return false;
    }
    return true;
  });
}

function countBy(rows, key) {
  const counts = new Map();
  for (const r of rows) {
    const value = r[key] || '(blank)';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function medianOf(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Weekly volume -- the number that decides whether a slice is worth selling.
 *
 * Only *complete* Mon-Sun weeks count. The first and last week of any pull are
 * partial by construction, and including them drags the median toward zero and
 * makes a healthy feed look dead. Weeks with no records are counted as real
 * zeros: dropping them would hide exactly the quiet stretches that matter.
 */
export function weeklyStats(rows) {
  const dated = rows.filter((r) => r.date);
  if (dated.length === 0) {
    return { total: 0, dated: 0, weeks: [], completeWeeks: [], median: 0, mean: 0, range: null };
  }

  const days = dated.map((r) => r.date).sort(compareDay);
  const first = days[0];
  const last = days[days.length - 1];

  const counts = new Map();
  for (const r of dated) {
    const w = weekStart(r.date);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  const weeks = [];
  for (let w = weekStart(first); compareDay(w, last) <= 0; w = addDays(w, 7)) {
    weeks.push({
      week: w,
      count: counts.get(w) ?? 0,
      complete: compareDay(w, first) >= 0 && compareDay(addDays(w, 6), last) <= 0,
    });
  }

  const completeWeeks = weeks.filter((w) => w.complete);
  const values = completeWeeks.map((w) => w.count);

  return {
    total: rows.length,
    dated: dated.length,
    weeks,
    completeWeeks,
    median: medianOf(values),
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    range: { first, last, days: daysBetween(first, last) + 1 },
  };
}

/**
 * Per-week rate for every value of `key` -- the table that answers "which
 * slice is worth selling" without filtering to each one by hand.
 *
 * Every group is measured over the SAME list of complete weeks, taken from the
 * whole result set rather than each group's own first and last record. A
 * category that only appeared in March would otherwise be scored over its own
 * three weeks and look busier than one steady all year.
 */
export function sliceBreakdown(rows, key) {
  const overall = weeklyStats(rows);
  const weeks = overall.completeWeeks.map((w) => w.week);
  if (weeks.length === 0) return [];

  const position = new Map(weeks.map((w, i) => [w, i]));
  const groups = new Map();

  for (const row of rows) {
    if (!row.date) continue;
    const at = position.get(weekStart(row.date));
    if (at === undefined) continue; // falls in a partial week at either end
    const value = row[key] || '';
    let group = groups.get(value);
    if (!group) {
      group = { value, total: 0, counts: new Array(weeks.length).fill(0) };
      groups.set(value, group);
    }
    group.counts[at]++;
    group.total++;
  }

  return [...groups.values()]
    .map(({ value, total, counts }) => ({
      value,
      total,
      // Median, not mean: one bulk-upload week should not make a dead category
      // look like a steady product.
      perWeek: medianOf(counts),
      weeks: weeks.length,
    }))
    .sort((a, b) => b.perWeek - a.perWeek || b.total - a.total);
}

export function completeness(rows, fields) {
  return fields.map((field) => ({
    field,
    filled: rows.filter((r) => r[field] !== '' && r[field] != null).length,
    pct: rows.length ? (rows.filter((r) => r[field] !== '' && r[field] != null).length / rows.length) * 100 : 0,
  }));
}

export function breakdown(rows) {
  return { borough: countBy(rows, 'borough'), category: countBy(rows, 'category') };
}

/**
 * Display order and labels for record columns, across the CLI, the CSV export
 * and the web table. Defined once: three copies of this list drift the moment
 * a source gains a field, and the symptom is a column silently missing from
 * the export rather than an error.
 *
 * Not every source has every column -- `presentColumns` drops the empty ones.
 */
export const DISPLAY_COLUMNS = [
  ['date', 'Date'],
  ['name', 'Business'],
  ['category', 'Category'],
  ['permittee', 'Contractor'],
  ['status', 'Status'],
  ['building', 'No.'],
  ['street', 'Street'],
  ['borough', 'Borough'],
  ['zip', 'ZIP'],
  ['phone', 'Phone'],
  ['expires', 'Expires'],
  ['licenseType', 'Licensee'],
  ['permitType', 'Permit'],
  ['job', 'Job #'],
  ['id', 'ID'],
];

/** The columns that actually carry a value in these rows, in display order. */
export function presentColumns(rows) {
  return DISPLAY_COLUMNS.filter(([key]) => rows.some((r) => r[key] !== '' && r[key] != null));
}

// --- CSV ---------------------------------------------------------------

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Escape one CSV cell.
 *
 * Beyond quoting: a value starting with = + - @ (or tab/CR) is executed as a
 * formula when the file is opened in Excel or Sheets. Real business names do
 * start that way -- "=Best Cuts=", "+Plus Home Care" -- so they get a leading
 * apostrophe, which Excel strips on display. Genuine numbers are left alone so
 * -5 stays a number rather than becoming text.
 */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function toCsv(rows, columns) {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  // CRLF: Excel is the destination for most of these and it is the safe choice.
  return lines.join('\r\n') + '\r\n';
}
