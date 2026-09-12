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
  ['address', 'Address'],
  ['borough', 'Borough'],
  ['zip', 'ZIP'],
  ['phone', 'Phone'],
  ['status', 'Status'],
  ['expires', 'Expires'],
  ['licenseType', 'Licensee'],
  ['permitType', 'Permit'],
  ['job', 'Job #'],
  ['id', 'License #'],
];

// Mapped fields that never appear as a column of their own because they are
// combined into a derived one. Declared here so the invariant "every mapped
// field reaches the output somehow" stays checkable.
export const DERIVED_SOURCES = new Map([
  ['building', 'address'],
  ['street', 'address'],
]);

// Administrative fields worth dropping when every row shares one value: a
// column reading "Premises" 500 times is padding. Identity and location stay
// even when constant, so a buyer merging two files never loses the label.
const DROP_WHEN_UNIFORM = new Set(['licenseType', 'permitType', 'status', 'expires', 'job']);

/** The columns worth showing for these rows, in display order. */
export function presentColumns(rows) {
  return DISPLAY_COLUMNS.filter(([key]) => {
    const values = rows.map((r) => r[key]).filter((v) => v !== '' && v != null);
    if (values.length === 0) return false;
    if (DROP_WHEN_UNIFORM.has(key) && values.length === rows.length) {
      return new Set(values).size > 1;
    }
    return true;
  });
}

// --- presentation ------------------------------------------------------
//
// The portal publishes SHOUTING NAMES, three phone formats, and an address
// split across two columns. Cleaning that up is not decoration -- it is the
// thing a buyer is actually paying for, since otherwise they do it themselves.

// Kept uppercase because lowercasing them looks like a mistake. Inc, Corp, Ltd
// and Co are deliberately absent: convention title-cases those.
const KEEP_UPPER = new Set([
  'LLC', 'L.L.C.', 'LLP', 'PLLC', 'PC', 'P.C.', 'USA', 'U.S.A.', 'US', 'NY', 'NYC',
  'NJ', 'HVAC', 'TV', 'AC', 'DBA', 'II', 'III', 'IV', 'V', 'VI',
]);
// Deliberately not here: CT, which is Court far more often than Connecticut in
// a street address, and ST, which is Street rather than Saint.

// Lowercased inside a name, never as its first word.
const MINOR = new Set(['and', 'or', 'of', 'the', 'for', 'at', 'on', 'in', 'to', 'a', 'an', 'by', 'with']);

// Short vowel-less tokens are nearly always initials ("LT Home Consulting",
// "TJ Contracting") and read wrong title-cased. Street abbreviations are the
// exception -- ST, RD and DR have no vowels either, and "533 E 2nd ST" is worse
// than "533 E 2nd St".
const STREET_WORDS = new Set([
  'ST', 'RD', 'DR', 'CT', 'LN', 'PL', 'TER', 'AVE', 'AV', 'BLVD', 'PKWY', 'HWY',
  'SQ', 'CIR', 'EXPY', 'PLZ', 'MT', 'FT', 'BCH', 'PK', 'BRG', 'TPKE',
]);

function looksLikeInitials(bare) {
  const upper = bare.toUpperCase();
  if (upper.length < 2 || upper.length > 3) return false;
  if (STREET_WORDS.has(upper)) return false;
  return !/[AEIOUY]/.test(upper);
}

function titleCaseWord(word, isFirst) {
  const bare = word.replace(/[^A-Za-z0-9.'&/-]/g, '');
  if (bare === '') return word;
  if (KEEP_UPPER.has(bare.toUpperCase())) return word.toUpperCase();
  if (!isFirst && MINOR.has(bare.toLowerCase())) return word.toLowerCase();
  // Digits first: "2ND" has no vowel and would otherwise read as initials.
  // 2ND, 67TH -> 2nd, 67th
  if (/^\d+(ST|ND|RD|TH)$/i.test(bare)) return word.toLowerCase();
  // Street numbers, unit numbers, anything with a digit: leave alone.
  if (/\d/.test(bare)) return word;
  if (bare.length === 1) return word.toUpperCase();
  if (looksLikeInitials(bare)) return word.toUpperCase();

  const lower = word.toLowerCase();
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  if (/^mc[a-z]{2,}/.test(lower)) return 'Mc' + cap(lower.slice(2));
  if (/^o'[a-z]{2,}/.test(lower)) return "O'" + cap(lower.slice(2));
  // Hyphenated and slashed names capitalise on both sides of the separator.
  return lower.split(/([-/])/).map((part) => (part.length > 1 ? cap(part) : part)).join('');
}

/**
 * Title-case a SHOUTED value, and leave anything else exactly as typed.
 *
 * The all-caps test matters: "GreyStone Contracting NY Corp" was capitalised
 * deliberately by whoever registered it, and rewriting it would be worse than
 * doing nothing.
 */
export function titleCase(value) {
  const s = String(value ?? '').trim();
  if (s === '' || s !== s.toUpperCase()) return s;
  let seenWord = false;
  return s
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token)) return ' ';
      const result = titleCaseWord(token, !seenWord);
      seenWord = true;
      return result;
    })
    .join('');
}

/** One phone format. Anything that is not a plain US number is left alone. */
export function formatPhone(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** Clean one record for display and export. Filtering already happened. */
export function presentRow(row) {
  const street = titleCase(row.street);
  return {
    ...row,
    name: titleCase(row.name),
    permittee: titleCase(row.permittee),
    address: [row.building, street].filter(Boolean).join(' '),
    phone: formatPhone(row.phone),
  };
}

export function presentRows(rows) {
  return rows.map(presentRow);
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
  // A ZIP like 07728 becomes 7728 the moment Excel opens the file. The leading
  // apostrophe forces a text cell and is stripped on display; it fires only on
  // digit strings that start with a zero, so nothing else is touched.
  else if (/^0\d+$/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

/** `columns` is the [key, label] list from presentColumns; labels head the file. */
export function toCsv(rows, columns) {
  const cols = columns ?? DISPLAY_COLUMNS.filter(([k]) => rows.some((r) => r[k] != null));
  const lines = [cols.map(([, label]) => csvCell(label)).join(',')];
  for (const row of rows) lines.push(cols.map(([key]) => csvCell(row[key])).join(','));
  // CRLF: Excel is the destination for most of these and it is the safe choice.
  return lines.join('\r\n') + '\r\n';
}
