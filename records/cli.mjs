#!/usr/bin/env node
// CLI for the public-records feed. See records/README.md.

import { readFile, writeFile } from 'node:fs/promises';
import { getSource, SOURCES } from './sources.mjs';
import { fetchRows, MappingError, normalizeRow, probeSource } from './socrata.mjs';
import { mergeStore, readStore, storePath } from './store.mjs';
import { breakdown, completeness, filterRows, presentColumns, presentRows, toCsv, weeklyStats } from './digest.mjs';
import { addDays, today } from './normalize.mjs';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    const next = argv[i + 1];
    if (inline !== undefined) flags[key] = inline;
    else if (next !== undefined && !next.startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { flags, positional };
}

function num(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got '${value}'`);
  return n;
}

// A fixture lets every command run end-to-end with no network, which is how
// the pipeline gets exercised in a sandbox where the portal is unreachable.
async function fixtureFetch(path) {
  const rows = JSON.parse(await readFile(path, 'utf8'));
  return async (url) => {
    // Honour $limit and $offset the way the portal does. Serving one page and
    // then stopping made every fixture silently cap at 1000 rows, which is
    // exactly the bug class this fixture exists to rule out.
    const params = new URL(url).searchParams;
    const limit = Number(params.get('$limit') ?? 1000);
    const offset = Number(params.get('$offset') ?? 0);
    const page = rows.slice(offset, offset + limit);
    return { ok: true, status: 200, json: async () => page, text: async () => '' };
  };
}

async function clientOpts(flags) {
  const fixture = flags.fixture ?? process.env.RECORDS_FIXTURE;
  return fixture ? { fetchImpl: await fixtureFetch(fixture) } : {};
}

function pct(n) {
  return `${n.toFixed(0)}%`;
}

// --- commands ----------------------------------------------------------

function cmdSources() {
  for (const s of SOURCES) {
    console.log(`${s.id}`);
    console.log(`  ${s.label}  [${s.domain}/${s.dataset}]`);
    console.log(`  ${s.why}`);
    console.log(`  date field: ${s.dateField}   mapping confidence: ${s.confidence}`);
    console.log('');
  }
  console.log('Field names are unverified. Run `probe --all` before trusting a pull.');
}

async function cmdProbe(flags, positional) {
  const targets = flags.all ? SOURCES : [getSource(positional[0] ?? 'dcwp-licenses')];
  const opts = await clientOpts(flags);
  const sampleSize = num(flags.sample, 200);
  let problems = 0;

  for (const source of targets) {
    console.log(`\n=== ${source.id} (${source.domain}/${source.dataset}) ===`);
    let probe;
    try {
      probe = await probeSource(source, { sampleSize, ...opts });
    } catch (err) {
      console.log(`  FETCH FAILED: ${err.message.split('\n')[0]}`);
      problems++;
      continue;
    }
    if (probe.sampled === 0) {
      console.log('  dataset returned no rows -- cannot verify the mapping');
      problems++;
      continue;
    }
    console.log(`  sampled ${probe.sampled} rows\n`);
    console.log(`  ${'field'.padEnd(12)}${'column'.padEnd(26)}${'state'.padEnd(9)}filled  example`);

    for (const r of probe.results) {
      let state;
      if (!r.ok) {
        state = r.required ? 'MISSING!' : 'MISSING';
        problems++;
      } else if (r.pct === 0) {
        // The failure this command exists to catch: present but never populated.
        state = r.required ? 'EMPTY!' : 'EMPTY';
        problems++;
      } else {
        state = 'ok';
      }
      const filled = r.ok ? `${r.pct}%`.padStart(5) : '    -';
      console.log(`  ${r.canonical.padEnd(12)}${r.column.padEnd(26)}${state.padEnd(9)}${filled}   ${r.example}`);
    }

    const useful = probe.unmapped.filter((c) => c.pct >= 50);
    if (useful.length) {
      console.log('\n  populated columns you have not mapped:');
      for (const c of useful.slice(0, 12)) {
        console.log(`    ${c.column.padEnd(28)}${String(c.pct).padStart(3)}%   ${c.example}`);
      }
    }
  }

  if (problems) {
    console.log(
      `\n${problems} problem(s). MISSING = no such column. EMPTY = column exists but is ` +
        `blank in every sampled row.\nFix the column names in records/sources.mjs, then re-pull.`,
    );
    process.exitCode = 1;
  } else {
    console.log('\nEvery mapped field exists and carries data. Safe to pull.');
  }
}

async function cmdPull(flags, positional) {
  const source = getSource(positional[0] ?? 'dcwp-licenses');
  const days = num(flags.days, 90);
  const since = addDays(today(), -days);
  const opts = await clientOpts(flags);

  console.log(`Pulling ${source.id} since ${since} (${days} days)...`);
  let rows;
  try {
    rows = await fetchRows(source, {
      since,
      max: num(flags.max, Infinity),
      onPage: ({ total }) => process.stderr.write(`\r  ${total} rows`),
      ...opts,
    });
  } catch (err) {
    process.stderr.write('\n');
    if (err instanceof MappingError) {
      console.error(`\n${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  process.stderr.write('\n');

  const result = await mergeStore(source.id, rows);
  console.log(
    `  fetched ${rows.length}   new ${result.added}   updated ${result.updated}   ` +
      `store now ${result.total}`,
  );
  console.log(`  -> ${storePath(source.id)}`);
  if (result.added === 0 && rows.length > 0) {
    console.log('  (nothing new -- expected if you just ran this)');
  }
}

async function cmdStats(flags, positional) {
  const source = getSource(positional[0] ?? 'dcwp-licenses');
  const all = await readStore(source.id);
  if (all.length === 0) {
    console.log(`No data for ${source.id}. Run: node records/cli.mjs pull ${source.id}`);
    process.exitCode = 1;
    return;
  }

  const rows = filterRows(all, {
    borough: flags.borough === true ? undefined : flags.borough,
    category: flags.category === true ? undefined : flags.category,
    contains: flags.contains === true ? undefined : flags.contains,
  });

  const stats = weeklyStats(rows);
  const filters = [flags.borough, flags.category, flags.contains].filter((f) => f && f !== true);

  console.log(`\n${source.label}`);
  if (filters.length) console.log(`filtered by: ${filters.join(' + ')}`);
  console.log(`records:  ${stats.total}${stats.dated < stats.total ? ` (${stats.total - stats.dated} undated)` : ''}`);
  if (!stats.range) {
    console.log('no dated records -- check the date field mapping');
    return;
  }
  console.log(`range:    ${stats.range.first} to ${stats.range.last}  (${stats.range.days} days)`);
  console.log('');

  if (stats.completeWeeks.length === 0) {
    console.log('Not enough data for a weekly figure -- pull a wider window (--days 180).');
  } else {
    console.log(`MEDIAN ${stats.median} per week   (mean ${stats.mean.toFixed(1)}, over ${stats.completeWeeks.length} complete weeks)`);
    console.log('');
    const max = Math.max(...stats.completeWeeks.map((w) => w.count), 1);
    for (const w of stats.completeWeeks.slice(-12)) {
      const bar = '#'.repeat(Math.round((w.count / max) * 40));
      console.log(`  ${w.week}  ${String(w.count).padStart(5)}  ${bar}`);
    }
  }

  console.log('\nfield completeness:');
  for (const c of completeness(rows, ['name', 'category', 'borough', 'street', 'zip', 'status'])) {
    console.log(`  ${c.field.padEnd(10)} ${pct(c.pct).padStart(5)}`);
  }

  const { borough, category } = breakdown(rows);
  if (borough.length > 1) {
    console.log('\nby borough:');
    for (const [k, v] of borough.slice(0, 8)) console.log(`  ${String(k).padEnd(20)} ${v}`);
  }
  if (category.length > 1) {
    console.log('\ntop categories:');
    for (const [k, v] of category.slice(0, 12)) console.log(`  ${String(k).padEnd(40)} ${v}`);
  }

  console.log(
    '\nRule of thumb: a slice under ~15/week is too thin to sell on its own.\n' +
      'Widen the category or add a second borough before building on it.',
  );
}

async function cmdDigest(flags, positional) {
  const source = getSource(positional[0] ?? 'dcwp-licenses');
  const all = await readStore(source.id);
  if (all.length === 0) {
    console.log(`No data for ${source.id}. Run: node records/cli.mjs pull ${source.id}`);
    process.exitCode = 1;
    return;
  }

  const days = num(flags.days, 7);
  const rows = filterRows(all, {
    since: addDays(today(), -days),
    borough: flags.borough === true ? undefined : flags.borough,
    category: flags.category === true ? undefined : flags.category,
    status: flags.status === true ? undefined : flags.status,
    contains: flags.contains === true ? undefined : flags.contains,
  }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const presented = presentRows(rows);
  const columns = presentColumns(presented);

  if (flags.csv) {
    const path = flags.csv === true ? `${source.id}-${today()}.csv` : flags.csv;
    await writeFile(path, toCsv(presented, columns), 'utf8');
    console.log(`${presented.length} records -> ${path}`);
    return;
  }

  console.log(`\n${source.label} -- last ${days} days (${presented.length} records)\n`);
  for (const r of presented) {
    const where = [r.address, r.borough].filter(Boolean).join(', ');
    console.log(`${r.date}  ${r.name || r.permittee || '(no name)'}`);
    if (r.category) console.log(`            ${r.category}${r.status ? ` -- ${r.status}` : ''}`);
    if (where) console.log(`            ${where}${r.phone ? `  ${r.phone}` : ''}`);
  }
  if (presented.length === 0) console.log('(nothing in this window -- try --days 30 or drop a filter)');
}

const USAGE = `
Public-records feed -- NYC

  node records/cli.mjs sources
  node records/cli.mjs probe [source|--all]      check column names against the live dataset
  node records/cli.mjs pull <source> [--days 90] fetch + dedupe into records/data/
  node records/cli.mjs stats <source> [filters]  weekly volume -- is this slice sellable?
  node records/cli.mjs digest <source> [--days 7] [--csv file]

Filters:  --borough Queens  --category "Home Improvement"  --status Active  --contains pizza
Env:      SOCRATA_APP_TOKEN  free token, lifts the anonymous rate limit

Start here:
  node records/cli.mjs probe --all
  node records/cli.mjs pull dcwp-licenses --days 180
  node records/cli.mjs stats dcwp-licenses --borough Queens
`;

const COMMANDS = { sources: cmdSources, probe: cmdProbe, pull: cmdPull, stats: cmdStats, digest: cmdDigest };

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = COMMANDS[positional[0]];
  if (!command) {
    console.log(USAGE);
    process.exitCode = positional[0] ? 1 : 0;
    if (positional[0]) console.error(`Unknown command '${positional[0]}'`);
    return;
  }
  await command(flags, positional.slice(1));
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
