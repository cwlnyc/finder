import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addDays, compareDay, daysBetween, parseDay, today, weekStart } from './normalize.mjs';
import { assertMapping, buildUrl, fetchRows, MappingError, normalizeRow } from './socrata.mjs';
import { mergeStore, readStore } from './store.mjs';
import { csvCell, DISPLAY_COLUMNS, filterRows, presentColumns, toCsv, weeklyStats } from './digest.mjs';
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

test('toCsv emits a header and one CRLF row per record', () => {
  const csv = toCsv([{ date: '2026-08-10', name: 'Beta, Inc.' }], ['date', 'name']);
  assert.equal(csv, 'date,name\r\n2026-08-10,"Beta, Inc."\r\n');
  const missing = toCsv([{ date: '2026-08-10' }], ['date', 'name']);
  assert.equal(missing, 'date,name\r\n2026-08-10,\r\n', 'a missing column is blank, not "undefined"');
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

test('every mapped field has a display column', () => {
  // A field mapped but missing from DISPLAY_COLUMNS is fetched, stored, and
  // then silently dropped from both the table and the CSV.
  const known = new Set(DISPLAY_COLUMNS.map(([key]) => key));
  for (const source of SOURCES) {
    for (const field of Object.keys(source.fields)) {
      assert.ok(known.has(field), `${source.id} maps '${field}', which nothing will ever display`);
    }
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
