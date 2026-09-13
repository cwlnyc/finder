#!/usr/bin/env node
// Find the people you are going to sell the contractor list to.
//
// Mason (or Google Maps by hand) gives you business names and websites. This
// turns those websites into contact addresses and keeps track of who you have
// already written to, so nobody gets the same mail twice.

import { readFile, writeFile } from 'node:fs/promises';
import { crawlSite } from './crawl.mjs';
import { addSites, exportable, readProspects, storePath, updateProspect, writeProspects } from './store.mjs';
import { parseSiteFile } from './input.mjs';
import { BUYER_PRESETS, getPreset, searchPlaces } from './places.mjs';
import { normalizeUrl, siteDomain } from './crawl.mjs';
import { csvCell } from '../records/digest.mjs';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
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

// --- commands ----------------------------------------------------------

async function cmdAdd(flags, positional) {
  const path = flags.file ?? positional[0];
  if (!path) throw new Error('Usage: add <file>   (a .txt of URLs, or a CSV with a website column)');
  const sites = parseSiteFile(await readFile(path, 'utf8'));
  if (sites.length === 0) {
    console.log('No usable website addresses in that file.');
    console.log('Expected one URL per line, or a CSV with a column called website/url/site.');
    process.exitCode = 1;
    return;
  }
  const result = await addSites(sites);
  console.log(`${sites.length} sites read   ${result.added} new   ${result.skipped} already known`);
  console.log(`  -> ${storePath()}`);
  if (result.added) console.log(`\nNext:  node prospects/cli.mjs find`);
}

async function cmdBuyers() {
  for (const preset of BUYER_PRESETS) {
    console.log(`${preset.id.padEnd(12)}${preset.label}`);
    console.log(`            search: "${preset.query}"`);
    console.log(`            ${preset.why}\n`);
  }
  console.log('Use one:  node prospects/cli.mjs search --buyer insurance --area "Brooklyn NY"');
}

async function cmdSearch(flags, positional) {
  const area = flags.area === true ? '' : (flags.area ?? '');
  const term = flags.buyer ? getPreset(flags.buyer).query : positional.join(' ');
  if (!term) {
    throw new Error('Usage: search "commercial insurance broker" --area "Brooklyn NY"\n   or: search --buyer insurance --area "Brooklyn NY"');
  }
  const query = [term, area].filter(Boolean).join(' ');

  console.log(`Searching Google Places for: ${query}`);
  const result = await searchPlaces(query, { maxResults: num(flags.max, 40) });
  if (result.places.length === 0) {
    console.log(result.searched === 0
      ? '  Nothing found. Try a broader area or a plainer term.'
      : `  ${result.searched} businesses found, none with a website — nothing to look up.`);
    return;
  }

  const sites = [];
  for (const place of result.places) {
    const url = normalizeUrl(place.website);
    const domain = siteDomain(url);
    if (domain) sites.push({ url, domain, name: place.name });
  }
  const added = await addSites(sites, {});
  console.log(
    `  ${result.searched} found   ${result.withoutWebsite} without a website   ` +
      `${added.added} new   ${added.skipped} already known`,
  );
  console.log(`\nNext:  node prospects/cli.mjs find`);
}

async function cmdFind(flags) {
  const all = await readProspects();
  const limit = num(flags.limit, 25);
  const retry = Boolean(flags.retry);
  const queue = all
    .filter((p) => p.status === 'pending' || (retry && p.status === 'unreachable'))
    .slice(0, limit);

  if (queue.length === 0) {
    const pending = all.filter((p) => p.status === 'pending').length;
    console.log(all.length === 0
      ? 'Nothing to look up yet. Add some sites first:  node prospects/cli.mjs add sites.txt'
      : `Nothing pending${pending === 0 ? ' — everything has been tried' : ''}. Use --retry for the unreachable ones.`);
    return;
  }

  console.log(`Looking up ${queue.length} site${queue.length === 1 ? '' : 's'} (a few seconds each, on purpose)\n`);
  let found = 0;
  for (const [i, prospect] of queue.entries()) {
    process.stdout.write(`  ${String(i + 1).padStart(3)}/${queue.length}  ${prospect.domain.padEnd(34)}`);
    const result = await crawlSite(prospect.url, { maxPages: num(flags.pages, 5) });
    prospect.status = result.status;
    prospect.emails = result.emails.map((e) => e.email);
    prospect.crawledAt = new Date().toISOString();
    prospect.notes = result.error || '';
    if (prospect.emails.length) {
      found++;
      console.log(`${prospect.emails[0]}${prospect.emails.length > 1 ? ` (+${prospect.emails.length - 1})` : ''}`);
    } else {
      console.log(result.status === 'no-email' ? 'no address on the site' : result.error || result.status);
    }
    await writeProspects(all); // save as we go: a long run must survive a Ctrl-C
  }
  console.log(`\n${found} of ${queue.length} had a contact address.`);
  console.log('Review them:  node prospects/cli.mjs list');
}

const STATUS_LABEL = {
  ok: 'found', 'no-email': 'no address', unreachable: 'unreachable',
  'bad-url': 'bad url', pending: 'not tried', skip: 'skipped',
};

async function cmdList(flags) {
  const all = await readProspects();
  if (all.length === 0) { console.log('No prospects yet.'); return; }

  const wanted = flags.status === true ? undefined : flags.status;
  const rows = all
    .filter((p) => (wanted ? p.status === wanted : true))
    .filter((p) => (flags.emailed ? p.emailedAt : flags.new ? !p.emailedAt : true))
    .filter((p) => (flags.found ? p.emails.length > 0 : true));

  for (const p of rows) {
    const mark = p.repliedAt ? 'REPLIED' : p.emailedAt ? 'emailed' : '';
    console.log(`${p.domain.padEnd(34)}${(p.emails[0] ?? STATUS_LABEL[p.status] ?? p.status).padEnd(34)}${mark}`);
    if (p.name) console.log(`  ${p.name}`);
  }

  const counts = all.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {});
  const emailed = all.filter((p) => p.emailedAt).length;
  console.log(`\n${rows.length} shown of ${all.length}. ` +
    Object.entries(counts).map(([k, v]) => `${STATUS_LABEL[k] ?? k}: ${v}`).join('  ') +
    `  |  emailed: ${emailed}`);
}

async function cmdMark(flags, positional) {
  const domain = positional[0];
  if (!domain) throw new Error('Usage: mark <domain> --emailed | --replied | --skip');
  const now = new Date().toISOString();
  const changes = {};
  if (flags.emailed) changes.emailedAt = now;
  if (flags.replied) { changes.repliedAt = now; if (!flags.emailed) changes.emailedAt = changes.emailedAt ?? now; }
  if (flags.skip) changes.status = 'skip';
  if (flags.note) changes.notes = String(flags.note);
  if (Object.keys(changes).length === 0) throw new Error('Nothing to change. Pass --emailed, --replied, --skip or --note.');

  const updated = await updateProspect(domain, changes);
  console.log(`${updated.domain}: ${updated.repliedAt ? 'replied' : updated.emailedAt ? 'emailed' : updated.status}`);
}

async function cmdExport(flags) {
  const all = await readProspects();
  // Only what you can actually write to, and only what you have not written to
  // yet -- the whole point of the log is not mailing anyone twice.
  const rows = flags.all
    ? all.filter((p) => p.emails.length > 0).map((p) => ({ ...p, primary: p.emails[0], others: p.emails.slice(1) }))
    : exportable(all);
  if (rows.length === 0) {
    console.log(flags.all ? 'No addresses found yet.' : 'Nothing new to send. Use --all to include those already emailed.');
    return;
  }
  const cols = ['name', 'domain', 'email', 'other_emails', 'website'];
  const lines = [cols.join(',')];
  for (const p of rows) {
    lines.push([p.name, p.domain, p.primary, p.others.join(' '), p.url].map(csvCell).join(','));
  }
  const path = flags.csv === true || !flags.csv ? 'prospects.csv' : flags.csv;
  await writeFile(path, lines.join('\r\n') + '\r\n', 'utf8');
  console.log(`${rows.length} prospects -> ${path}`);
}

const USAGE = `
Find who to sell the list to

  node prospects/cli.mjs buyers           who might buy your data, and why
  node prospects/cli.mjs search --buyer insurance --area "Brooklyn NY"
  node prospects/cli.mjs add <file>        a .txt of URLs, or a CSV with a website column
  node prospects/cli.mjs find [--limit 25] look up contact addresses
  node prospects/cli.mjs list [--found]    what you have
  node prospects/cli.mjs mark <domain> --emailed
  node prospects/cli.mjs export --csv out.csv

Needs a key for search:  export GOOGLE_PLACES_API_KEY=...
(console.cloud.google.com, enable "Places API (New)")

Typical run:
  node prospects/cli.mjs search --buyer insurance --area "Brooklyn NY"

  node prospects/cli.mjs find
  node prospects/cli.mjs export --csv brokers-to-email.csv
  ...send the mail, then...
  node prospects/cli.mjs mark acmeinsurance.com --emailed

export skips anyone already marked emailed, so nobody gets it twice.
`;

const COMMANDS = {
  buyers: cmdBuyers, search: cmdSearch, add: cmdAdd,
  find: cmdFind, list: cmdList, mark: cmdMark, export: cmdExport,
};

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = COMMANDS[positional[0]];
  if (!command) {
    console.log(USAGE);
    if (positional[0]) { console.error(`Unknown command '${positional[0]}'`); process.exitCode = 1; }
    return;
  }
  await command(flags, positional.slice(1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(`\n${err.message}`); process.exitCode = 1; });
}
