import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addDays, compareDay, daysBetween, parseDay, today, weekStart } from './normalize.mjs';
import { assertMapping, buildUrl, fetchRows, MappingError, normalizeRow, probeSource } from './socrata.mjs';
import { mergeStore, readStore } from './store.mjs';
import {
  completeness, csvCell, DERIVED_SOURCES, DISPLAY_COLUMNS, filterRows, formatPhone,
  presentColumns, presentRow, presentRows, titleCase, toCsv, weeklyStats,
} from './digest.mjs';
import { getSource, SOURCES } from './sources.mjs';

const LICENSES = getSource('dcwp-licenses');

// --- dates -------------------------------------------------------------

test('parseDay accepts every shape the portal emits', () => {
  assert.equal(parseDay('2026-08-14T00:00:00.000'), '2026-08-14');
  assert.equal(parseDay('2026-08-14T13:45:00'), '2026-08-14');
  assert.equal(parseDay('2026-08-14T00:00:00.000Z'), '2026-08-14');
  assert.equal(parseDay('2026-08-14'), '2026-08-14');
  assert.equal(parseDay('8/14/2026'), '2026-08-14');
  assert.equal(parseDay('08/14/2026'), '2026-08-14');
  assert.equal(parseDay('  2026-08-14  '), '2026-08-14');
});

test('parseDay rejects junk instead of inventing a date', () => {
  for (const bad of ['', '   ', null, undefined, 'n/a', '2026-13-01', '02/30/2026', '2026-02-30', 'TBD']) {
    assert.equal(parseDay(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('a floating timestamp keeps its calendar day regardless of local zone', () => {
  // The bug this guards: `new Date('2026-08-14T00:00:00.000')` is LOCAL time, so
  // west of UTC it stringifies back as the 13th and the record moves a day.
  assert.equal(parseDay('2026-08-14T00:00:00.000'), '2026-08-14');
  assert.equal(parseDay('2026-01-01T00:00:00.000'), '2026-01-01');
  assert.equal(parseDay('2026-12-31T23:59:59.000'), '2026-12-31');
});

test('weekStart puts Sunday in the week that already started', () => {
  // getUTCDay() calls Sunday 0, so the naive subtraction rolls it forward into
  // next week and splits the weekend across two buckets.
  assert.equal(weekStart('2026-08-10'), '2026-08-10', 'Monday');
  assert.equal(weekStart('2026-08-13'), '2026-08-10', 'Thursday');
  assert.equal(weekStart('2026-08-15'), '2026-08-10', 'Saturday');
  assert.equal(weekStart('2026-08-16'), '2026-08-10', 'Sunday');
  assert.equal(weekStart('2026-08-17'), '2026-08-17', 'next Monday');
});

test('weekStart crosses month and year boundaries', () => {
  assert.equal(weekStart('2027-01-03'), '2026-12-28'); // Sunday into the prior year
  assert.equal(weekStart('2026-03-01'), '2026-02-23');
});

test('addDays and daysBetween handle leap years', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.equal(daysBetween('2028-01-01', '2029-01-01'), 366);
  assert.equal(daysBetween('2026-08-14', '2026-08-14'), 0);
  assert.equal(daysBetween('2026-08-14', '2026-08-10'), -4);
});

test('compareDay orders lexically and chronologically alike', () => {
  assert.equal(compareDay('2026-08-09', '2026-08-10'), -1);
  assert.equal(compareDay('2026-09-01', '2026-08-31'), 1);
  assert.equal(compareDay('2026-08-10', '2026-08-10'), 0);
});

test('today returns a well-formed day in the requested zone', () => {
  // 03:30 UTC is still the previous evening in New York.
  const instant = new Date('2026-08-14T03:30:00Z');
  assert.equal(today('America/New_York', instant), '2026-08-13');
  assert.equal(today('UTC', instant), '2026-08-14');
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

// --- socrata -----------------------------------------------------------

test('paged requests are always ordered, or rows vanish silently', () => {
  // $offset without $order is undefined behaviour in Socrata: pages can come
  // back in a different order each time, so rows are skipped and duplicated
  // with no error raised anywhere.
  const url = new URL(buildUrl(LICENSES, { since: '2026-06-01', offset: 1000 }));
  assert.equal(url.searchParams.get('$order'), ':id');
  assert.equal(url.searchParams.get('$offset'), '1000');
  assert.equal(url.searchParams.get('$limit'), '1000');
});

test('the date filter uses a floating-timestamp literal', () => {
  const where = new URL(buildUrl(LICENSES, { since: '2026-06-01' })).searchParams.get('$where');
  assert.equal(where, "license_creation_date >= '2026-06-01T00:00:00'");
  // A trailing Z makes the portal reject the comparison outright.
  assert.ok(!where.includes('Z'), 'SoQL floating timestamps must not carry a zone');
});

test('normalizeRow trims and turns missing columns into empty strings', () => {
  const row = normalizeRow(LICENSES, {
    license_nbr: ' 12345 ',
    business_name: 'Best Cuts',
    license_creation_date: '2026-08-14T00:00:00.000',
    address_borough: null,
  });
  assert.equal(row.id, '12345');
  assert.equal(row.name, 'Best Cuts');
  assert.equal(row.borough, '');
  assert.equal(row.zip, '', 'a column absent from the response is empty, not undefined');
});

test('assertMapping blocks a batch whose required columns were renamed', () => {
  // The silent disaster: a renamed column makes every lookup undefined, the
  // pull "succeeds", and thousands of blank rows overwrite good data.
  const stale = Array.from({ length: 20 }, (_, i) => ({ id: '', date: '', name: '', category: 'x' + i }));
  assert.throws(() => assertMapping(LICENSES, stale), (err) => {
    assert.ok(err instanceof MappingError);
    assert.match(err.message, /looks stale/);
    assert.match(err.message, /license_nbr/, 'names the offending column');
    assert.match(err.message, /Nothing was written/);
    return true;
  });
});

test('assertMapping tolerates ordinary partial rows', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `L${i}`,
    date: '2026-08-14',
    name: i < 2 ? '' : `Shop ${i}`, // a couple of genuinely nameless records
    borough: '',
  }));
  assert.doesNotThrow(() => assertMapping(LICENSES, rows));
  assert.doesNotThrow(() => assertMapping(LICENSES, []), 'an empty page is not a mapping failure');
});

test('fetchRows stops at a short page and normalizes as it goes', async () => {
  const page = Array.from({ length: 3 }, (_, i) => ({
    license_nbr: `L${i}`,
    business_name: `Shop ${i}`,
    license_creation_date: '2026-08-14T00:00:00.000',
  }));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => page, text: async () => '' };
  };
  const rows = await fetchRows(LICENSES, { since: '2026-08-01', fetchImpl });
  assert.equal(calls, 1, 'a page shorter than the limit means the end of the data');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'Shop 0');
});

test('fetchRows surfaces a stale mapping instead of returning blanks', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => Array.from({ length: 5 }, () => ({ renamed_col: 'x' })),
    text: async () => '',
  });
  await assert.rejects(() => fetchRows(LICENSES, { since: '2026-08-01', fetchImpl }), MappingError);
});

test('an HTTP error explains the likely cause', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'bad column' });
  await assert.rejects(() => fetchRows(LICENSES, { fetchImpl }), /HTTP 400.*probe/s);
});

// --- store -------------------------------------------------------------

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'records-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('re-pulling an overlapping window reports nothing as new twice', async () => {
  await withTempDir(async (dir) => {
    const batch = [
      { id: 'L1', date: '2026-08-10', name: 'Alpha' },
      { id: 'L2', date: '2026-08-11', name: 'Beta' },
    ];
    const first = await mergeStore('t', batch, { dir, now: '2026-08-12T00:00:00Z' });
    assert.deepEqual({ added: first.added, total: first.total }, { added: 2, total: 2 });

    // Same window pulled again the next day, plus one genuinely new record.
    const second = await mergeStore('t', [...batch, { id: 'L3', date: '2026-08-12', name: 'Gamma' }], {
      dir,
      now: '2026-08-13T00:00:00Z',
    });
    assert.equal(second.added, 1, 'only the new record counts as new');
    assert.equal(second.total, 3);

    const stored = await readStore('t', dir);
    assert.equal(stored.find((r) => r.id === 'L1').firstSeen, '2026-08-12T00:00:00Z',
      'firstSeen survives a re-pull, or old businesses resurface as fresh leads');
  });
});

test('a changed record updates in place rather than duplicating', async () => {
  await withTempDir(async (dir) => {
    await mergeStore('t', [{ id: 'L1', date: '2026-08-10', name: 'Alpha', status: 'Pending' }], { dir });
    const r = await mergeStore('t', [{ id: 'L1', date: '2026-08-10', name: 'Alpha', status: 'Active' }], { dir });
    assert.deepEqual({ added: r.added, updated: r.updated, total: r.total }, { added: 0, updated: 1, total: 1 });
    const stored = await readStore('t', dir);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'Active');
  });
});

test('unkeyed rows are dropped, since they cannot be deduped', async () => {
  await withTempDir(async (dir) => {
    const r = await mergeStore('t', [{ id: '', date: '2026-08-10', name: 'No key' }], { dir });
    assert.equal(r.added, 0);
    assert.equal((await readStore('t', dir)).length, 0);
  });
});

test('the store round-trips and stays sorted by date', async () => {
  await withTempDir(async (dir) => {
    await mergeStore('t', [
      { id: 'L3', date: '2026-08-12', name: 'Gamma' },
      { id: 'L1', date: '2026-08-10', name: 'Alpha' },
      { id: 'L2', date: '2026-08-11', name: 'Beta, Inc.' },
    ], { dir });
    const stored = await readStore('t', dir);
    assert.deepEqual(stored.map((r) => r.id), ['L1', 'L2', 'L3']);
    assert.equal(stored[1].name, 'Beta, Inc.', 'commas survive the JSONL round trip');
  });
});

test('reading a store that does not exist yet is empty, not an error', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await readStore('never-pulled', dir), []);
  });
});

// --- digest ------------------------------------------------------------

const SAMPLE = [
  { id: '1', date: '2026-08-10', name: 'Queens Pizza', category: 'Home Improvement Contractor', borough: 'Queens', status: 'Active' },
  { id: '2', date: '2026-08-11', name: 'Bronx Cuts', category: 'Home Improvement Salesperson', borough: 'Bronx', status: 'Active' },
  { id: '3', date: '2026-08-12', name: 'Astoria Deli', category: 'Sidewalk Cafe', borough: 'QUEENS', status: 'Inactive' },
  { id: '4', date: '', name: 'Undated Co', category: 'Sidewalk Cafe', borough: 'Queens', status: 'Active' },
];

test('category filtering is a substring match, not equality', () => {
  // "Home Improvement" must catch both Contractor and Salesperson, or the
  // useful slices are unreachable.
  assert.equal(filterRows(SAMPLE, { category: 'Home Improvement' }).length, 2);
  assert.equal(filterRows(SAMPLE, { category: 'home improvement contractor' }).length, 1);
});

test('borough filtering ignores the portal\'s inconsistent casing', () => {
  const rows = filterRows(SAMPLE, { borough: 'Queens' });
  assert.deepEqual(rows.map((r) => r.id), ['1', '3'], 'QUEENS and Queens are the same place');
});

test('filters compose and undated rows never pass', () => {
  assert.deepEqual(filterRows(SAMPLE, { borough: 'Queens', status: 'Active' }).map((r) => r.id), ['1']);
  assert.equal(filterRows(SAMPLE, {}).length, 3, 'the undated row is excluded from every result');
  assert.deepEqual(filterRows(SAMPLE, { since: '2026-08-11' }).map((r) => r.id), ['2', '3']);
  assert.deepEqual(filterRows(SAMPLE, { until: '2026-08-10' }).map((r) => r.id), ['1']);
  assert.deepEqual(filterRows(SAMPLE, { contains: 'pizza' }).map((r) => r.id), ['1']);
});

test('weekly volume counts only complete weeks', () => {
  // Mon 2026-08-03 through Sun 2026-08-30: exactly four whole weeks.
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, date: '2026-08-05' })),
    // week of 08-10 deliberately empty
    ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, date: '2026-08-19' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, date: '2026-08-26' })),
    { id: 'edge-first', date: '2026-08-03' },
    { id: 'edge-last', date: '2026-08-30' },
  ];
  const stats = weeklyStats(rows);
  assert.equal(stats.completeWeeks.length, 4);
  assert.deepEqual(stats.completeWeeks.map((w) => w.count), [6, 0, 10, 21]);
  assert.equal(stats.median, 8, 'median of [0,6,10,21]');
  assert.equal(stats.range.first, '2026-08-03');
  assert.equal(stats.range.last, '2026-08-30');
});

test('an empty week counts as a real zero', () => {
  // Dropping silent weeks would hide exactly the droughts that kill a feed.
  const stats = weeklyStats([
    { id: 'a', date: '2026-08-03' },
    { id: 'b', date: '2026-08-24' },
    { id: 'c', date: '2026-08-30' },
  ]);
  assert.deepEqual(stats.completeWeeks.map((w) => w.count), [1, 0, 0, 2]);
  assert.equal(stats.median, 0.5);
});

test('partial weeks at both ends are excluded, not counted as droughts', () => {
  // Starting Wednesday: that week is partial and would otherwise report a
  // fake low count that drags the median down.
  const rows = [
    { id: 'a', date: '2026-08-05' }, // Wed -- partial leading week
    ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, date: '2026-08-12' })),
    { id: 'z', date: '2026-08-19' }, // Wed -- partial trailing week
  ];
  const stats = weeklyStats(rows);
  assert.equal(stats.completeWeeks.length, 1);
  assert.deepEqual(stats.completeWeeks.map((w) => w.week), ['2026-08-10']);
  assert.equal(stats.median, 9);
});

test('weeklyStats survives having nothing to say', () => {
  const stats = weeklyStats([]);
  assert.equal(stats.median, 0);
  assert.equal(stats.range, null);
  assert.deepEqual(weeklyStats([{ id: 'x', date: '' }]).completeWeeks, []);
});

test('a business name starting with = does not execute in Excel', () => {
  // "=Best Cuts" and "+Plus Home Care" are real name shapes, and a spreadsheet
  // treats them as formulas the moment the lead list is opened.
  assert.equal(csvCell('=Best Cuts'), "'=Best Cuts");
  assert.equal(csvCell('+Plus Home Care'), "'+Plus Home Care");
  assert.equal(csvCell('@Home Services'), "'@Home Services");
  assert.equal(csvCell('-Dash Deli'), "'-Dash Deli");
  assert.equal(csvCell('=cmd|"/c calc"!A0'), `"'=cmd|""/c calc""!A0"`, 'defused and quoted');
});

test('genuine numbers are not mangled by the formula defence', () => {
  assert.equal(csvCell('-5'), '-5');
  assert.equal(csvCell('-12.75'), '-12.75');
  assert.equal(csvCell('11374'), '11374');
});

test('csvCell quotes commas, quotes and newlines', () => {
  assert.equal(csvCell('Beta, Inc.'), '"Beta, Inc."');
  assert.equal(csvCell('The "Best" Deli'), '"The ""Best"" Deli"');
  assert.equal(csvCell('Line1\nLine2'), '"Line1\nLine2"');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('toCsv heads the file with human labels, not field keys', () => {
  const cols = [['date', 'Date'], ['name', 'Business']];
  const csv = toCsv([{ date: '2026-08-10', name: 'Beta, Inc.' }], cols);
  assert.equal(csv, 'Date,Business\r\n2026-08-10,"Beta, Inc."\r\n');
  const missing = toCsv([{ date: '2026-08-10' }], cols);
  assert.equal(missing, 'Date,Business\r\n2026-08-10,\r\n', 'a missing column is blank, not "undefined"');
});

test('normalizeRow collapses the portal timestamp to a calendar day', () => {
  // Regression: without this, every stored date kept its 'T00:00:00.000' tail.
  // weekStart() then parsed '07T00:00:00.000' as NaN and --until dropped
  // boundary-day records, both without raising anything.
  const row = normalizeRow(LICENSES, {
    license_nbr: 'L1',
    business_name: 'Shop',
    license_creation_date: '2026-09-07T00:00:00.000',
  });
  assert.equal(row.date, '2026-09-07');
  assert.equal(weekStart(row.date), '2026-09-07');
  assert.deepEqual(filterRows([row], { until: '2026-09-07' }).map((r) => r.id), ['L1'],
    'a record on the boundary day is included, not dropped');
});

test('an unparseable date becomes empty rather than poisoning the buckets', () => {
  const row = normalizeRow(LICENSES, { license_nbr: 'L2', business_name: 'Shop', license_creation_date: 'N/A' });
  assert.equal(row.date, '');
  assert.equal(filterRows([row], {}).length, 0);
});

// --- source definitions ------------------------------------------------

test('every source filters on the same column it stores as the date', () => {
  // If dateField and fields.date drift apart, the $where narrows on one column
  // while normalizeRow reads another: you fetch the right rows and store blank
  // dates, or filter on a column you never keep. Neither raises anything.
  for (const source of SOURCES) {
    assert.equal(source.dateField, source.fields.date, `${source.id} filters and stores different columns`);
  }
});

test('every required field is actually mapped', () => {
  for (const source of SOURCES) {
    for (const field of source.required) {
      assert.ok(source.fields[field], `${source.id} requires '${field}' but does not map it`);
    }
  }
});

test('every mapped field reaches the output somehow', () => {
  // A field mapped but neither displayed nor folded into a derived column is
  // fetched, stored, and then silently dropped from the table and the CSV.
  const shown = new Set(DISPLAY_COLUMNS.map(([key]) => key));
  for (const source of SOURCES) {
    for (const field of Object.keys(source.fields)) {
      const reaches = shown.has(field) || shown.has(DERIVED_SOURCES.get(field));
      assert.ok(reaches, `${source.id} maps '${field}', which nothing will ever display`);
    }
  }
});

test('derived columns name a real destination', () => {
  const shown = new Set(DISPLAY_COLUMNS.map(([key]) => key));
  for (const [from, to] of DERIVED_SOURCES) {
    assert.ok(shown.has(to), `'${from}' claims to feed '${to}', which is not a column`);
  }
});

test('presentColumns keeps display order and drops empty columns', () => {
  const rows = [
    { date: '2026-08-10', name: 'Alpha', category: '', phone: '718-555-0100', id: 'L1' },
    { date: '2026-08-11', name: 'Beta', category: '', phone: '', id: 'L2' },
  ];
  const keys = presentColumns(rows).map(([key]) => key);
  assert.deepEqual(keys, ['date', 'name', 'phone', 'id'], 'category is empty everywhere, so it is dropped');
  assert.deepEqual(
    keys,
    DISPLAY_COLUMNS.map(([k]) => k).filter((k) => keys.includes(k)),
    'and the order follows DISPLAY_COLUMNS, not the order of the object keys',
  );
  assert.deepEqual(presentColumns([]), [], 'no rows means no columns');
});

test('presentColumns labels every column it returns', () => {
  const [, label] = presentColumns([{ phone: '718-555-0100' }])[0];
  assert.equal(label, 'Phone');
});

test('secondary date columns are parsed too, not just the primary one', () => {
  // Regression: only `date` was collapsed, so an expiry kept its
  // 'T00:00:00.000' tail and rendered as a truncated string in the table.
  const row = normalizeRow(LICENSES, {
    license_nbr: 'L1',
    business_name: 'Shop',
    license_creation_date: '2026-09-07T00:00:00.000',
    lic_expir_dd: '2028-06-01T00:00:00.000',
  });
  assert.equal(row.date, '2026-09-07');
  assert.equal(row.expires, '2028-06-01');
});

test('a source without an expiry column is unaffected', () => {
  const permits = getSource('dob-permits');
  const row = normalizeRow(permits, { permit_si_no: 'P1', issuance_date: '2026-09-07T00:00:00.000' });
  assert.equal(row.date, '2026-09-07');
  assert.ok(!('expires' in row), 'no phantom column appears for sources that lack one');
});

test('completeness flags a column that is blank in every record', () => {
  // This is what tells the UI a field mapping is stale rather than the data
  // merely being patchy: 0 filled, not "a few missing".
  const rows = [
    { name: 'Alpha', category: '', borough: 'Queens' },
    { name: 'Beta', category: '', borough: '' },
  ];
  const result = completeness(rows, ['name', 'category', 'borough']);
  assert.deepEqual(result.find((c) => c.field === 'category'), { field: 'category', filled: 0, pct: 0 });
  assert.equal(result.find((c) => c.field === 'name').pct, 100);
  assert.equal(result.find((c) => c.field === 'borough').filled, 1, 'partly blank is not the same as wholly blank');
});

// --- probe -------------------------------------------------------------

const fakeFetch = (rows) => async () => ({
  ok: true, status: 200, json: async () => rows, text: async () => '',
});

test('probe separates a missing column from an empty one', () => {
  // These need different fixes -- a wrong name vs. the right name on a column
  // nobody fills -- and reporting both as "BAD" sent me chasing the wrong one.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    license_nbr: `L${i}`,
    business_name: `Shop ${i}`,
    license_creation_date: '2026-09-07T00:00:00.000',
    business_category: '   ',        // present, always blank
    license_type: 'Sidewalk Cafe',   // the column actually carrying the industry
  }));
  return probeSource(LICENSES, { fetchImpl: fakeFetch(rows) }).then((probe) => {
    const category = probe.results.find((r) => r.canonical === 'category');
    assert.equal(category.ok, true, 'the column exists');
    assert.equal(category.pct, 0, 'but nothing is in it');

    const expires = probe.results.find((r) => r.canonical === 'expires');
    assert.equal(expires.ok, false, 'absent from every row means missing');

    const id = probe.results.find((r) => r.canonical === 'id');
    assert.equal(id.pct, 100);
    assert.equal(id.example, 'L0');
  });
});

test('probe surfaces populated columns that are not mapped', () => {
  const rows = Array.from({ length: 10 }, () => ({
    license_nbr: 'L1', business_name: 'Shop', license_creation_date: '2026-09-07',
    license_type: 'Sidewalk Cafe', some_empty_col: '',
  }));
  return probeSource(LICENSES, { fetchImpl: fakeFetch(rows) }).then((probe) => {
    const names = probe.unmapped.map((c) => c.column);
    assert.ok(!names.includes('license_nbr'), 'mapped columns are not listed as unmapped');
    assert.ok(names.includes('some_empty_col'));
    // Sorted by fill rate so the useful candidate leads.
    assert.equal(probe.unmapped[0].pct, 0, 'nothing here is populated except mapped fields');
  });
});

test('probe unions column names across the sample', () => {
  // Socrata omits null fields per row, so a column present only in later rows
  // would read as missing if we looked at the first row alone.
  const rows = [
    { license_nbr: 'L1', business_name: 'A', license_creation_date: '2026-09-07' },
    { license_nbr: 'L2', business_name: 'B', license_creation_date: '2026-09-07', address_zip: '11106' },
  ];
  return probeSource(LICENSES, { fetchImpl: fakeFetch(rows) }).then((probe) => {
    const zip = probe.results.find((r) => r.canonical === 'zip');
    assert.equal(zip.ok, true, 'found even though the first row lacked it');
    assert.equal(zip.pct, 50);
  });
});

test('paging accumulates every row exactly once', async () => {
  // 2500 rows is three pages: two full and a short one. Nothing may be
  // skipped at a page boundary and nothing may arrive twice -- both are
  // silent, and both corrupt every count downstream.
  const all = Array.from({ length: 2500 }, (_, i) => ({
    license_nbr: `L${i}`,
    business_name: `Shop ${i}`,
    license_creation_date: '2026-08-14T00:00:00.000',
  }));
  const seen = [];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const offset = Number(params.get('$offset') ?? 0);
    const limit = Number(params.get('$limit'));
    seen.push(offset);
    return { ok: true, status: 200, json: async () => all.slice(offset, offset + limit), text: async () => '' };
  };

  const rows = await fetchRows(LICENSES, { since: '2026-08-01', fetchImpl });
  assert.deepEqual(seen, [0, 1000, 2000], 'three sequential pages');
  assert.equal(rows.length, 2500);
  assert.equal(new Set(rows.map((r) => r.id)).size, 2500, 'no duplicates');
  assert.equal(rows[999].id, 'L999');
  assert.equal(rows[1000].id, 'L1000', 'no gap across the page boundary');
});

test('max stops paging early without over-fetching', async () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({
    license_nbr: `L${i}`, business_name: 'Shop', license_creation_date: '2026-08-14',
  }));
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const p = new URL(url).searchParams;
    const offset = Number(p.get('$offset') ?? 0);
    return { ok: true, status: 200, json: async () => all.slice(offset, offset + Number(p.get('$limit'))), text: async () => '' };
  };
  const rows = await fetchRows(LICENSES, { since: '2026-08-01', max: 1500, fetchImpl });
  assert.equal(rows.length, 1500);
  assert.equal(calls, 2, 'stopped once the cap was reached');
});

// --- presentation ------------------------------------------------------

test('SHOUTED names become readable without losing their suffix', () => {
  assert.equal(titleCase('BREAD WINNERS CONSTRUCTION LLC'), 'Bread Winners Construction LLC');
  assert.equal(titleCase('D & R MAINTENANCE, INC.'), 'D & R Maintenance, Inc.');
  assert.equal(titleCase('ZIKOS MILLWORK AND CONTRACTING LLC'), 'Zikos Millwork and Contracting LLC');
  assert.equal(titleCase('MCDONALD BROS'), 'McDonald Bros');
  assert.equal(titleCase("O'BRIEN & SONS"), "O'Brien & Sons");
  assert.equal(titleCase('THE HOME DEPOT'), 'The Home Depot', 'a minor word still leads');
});

test('deliberate capitalisation is left exactly as typed', () => {
  // "GreyStone" was written that way on purpose; rewriting it is worse than
  // doing nothing, so only all-caps values are touched.
  for (const name of ['GreyStone Contracting NY Corp', 'iRepair NYC', 'eBay Motors']) {
    assert.equal(titleCase(name), name);
  }
  assert.equal(titleCase(''), '');
  assert.equal(titleCase(null), '');
});

test('street abbreviations survive title casing', () => {
  assert.equal(titleCase('E 2ND ST'), 'E 2nd St');
  assert.equal(titleCase('BRIGHTON 10TH CT'), 'Brighton 10th Ct', 'CT is Court here, not Connecticut');
  assert.equal(titleCase('199-20 32ND AVENUE'), '199-20 32nd Avenue');
  assert.equal(titleCase('PARK TER E'), 'Park Ter E');
  assert.equal(titleCase('MOUNT MORRIS PARK W'), 'Mount Morris Park W');
});

test('every phone ends up in one format', () => {
  // The portal mixes all of these in one column, and the buyer would otherwise
  // clean them by hand -- which is the chore they are paying to avoid.
  for (const input of ['3474267055', '(347) 426-7055', '347-426-7055', '13474267055', '347.426.7055']) {
    assert.equal(formatPhone(input), '(347) 426-7055', input);
  }
});

test('anything that is not a plain US number is left alone', () => {
  assert.equal(formatPhone('x1234'), 'x1234');
  assert.equal(formatPhone('212555616'), '212555616', 'nine digits is not silently padded');
  assert.equal(formatPhone(''), '');
  assert.equal(formatPhone(null), '');
});

test('presentRow joins the address and leaves raw fields intact', () => {
  const row = presentRow({
    name: 'S4M CONSTRUCTION CORP', building: '533', street: 'E 2ND ST',
    borough: 'Brooklyn', phone: '3474588357', zip: '11218',
  });
  assert.equal(row.address, '533 E 2nd St');
  assert.equal(row.name, 'S4M Construction Corp');
  assert.equal(row.phone, '(347) 458-8357');
  assert.equal(row.borough, 'Brooklyn', 'filter values are never rewritten');
  assert.equal(presentRows([{ name: 'A', building: '', street: '' }])[0].address, '');
});

test('a leading-zero ZIP survives Excel', () => {
  // 07728 becomes 7728 the moment Excel opens the file without this.
  assert.equal(csvCell('07728'), "'07728");
  assert.equal(csvCell('11218'), '11218', 'ordinary ZIPs are untouched');
  assert.equal(csvCell('0'), '0');
  assert.equal(csvCell('0016371-DCA'), '0016371-DCA', 'not a bare digit string');
});

test('a column identical on every row is dropped from the output', () => {
  // licenseType reads "Premises" on all 500 rows -- padding, not information.
  const rows = Array.from({ length: 5 }, (_, i) => ({
    date: '2026-08-14', name: `Shop ${i}`, address: '1 Main St',
    licenseType: 'Premises', status: i < 2 ? 'Active' : 'Inactive',
  }));
  const keys = presentColumns(rows).map(([key]) => key);
  assert.ok(!keys.includes('licenseType'), 'uniform administrative column dropped');
  assert.ok(keys.includes('status'), 'the same column kept once it varies');
});

test('identity and location columns stay even when uniform', () => {
  // Dropping these would lose the label when a buyer merges two files.
  const rows = Array.from({ length: 5 }, (_, i) => ({
    date: '2026-08-14', name: `Shop ${i}`, category: 'Home Improvement Contractor',
    borough: 'Queens', address: '1 Main St',
  }));
  const keys = presentColumns(rows).map(([key]) => key);
  assert.ok(keys.includes('category'));
  assert.ok(keys.includes('borough'));
});

test('short vowel-less tokens read as initials, not words', () => {
  assert.equal(titleCase('LT HOME CONSULTING LLC'), 'LT Home Consulting LLC');
  assert.equal(titleCase('TJ CONTRACTING'), 'TJ Contracting');
  assert.equal(titleCase('JG CONSTRUCTION INC.'), 'JG Construction Inc.');
});

test('the initials rule does not eat ordinals or street suffixes', () => {
  // ST, RD and DR have no vowels either, and "2ND" has none at all -- each
  // would read as initials without an explicit exception.
  assert.equal(titleCase('533 E 2ND ST'), '533 E 2nd St');
  assert.equal(titleCase('8503 67TH AVE'), '8503 67th Ave');
  assert.equal(titleCase('71 POTTER RD'), '71 Potter Rd');
  assert.equal(titleCase('MT VERNON DR'), 'Mt Vernon Dr');
});
