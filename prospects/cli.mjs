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
import {
  buildBody, buildFollowUp, followUpSubject, isPersonAddress, loadSampleRecords, SUBJECT,
} from './compose.mjs';
import { sendMail, SmtpError } from './smtp.mjs';

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
    .filter((p) => !flags.people || (p.emails.length > 0 && isPersonAddress(p.emails[0])))
    .filter((p) => (flags.found ? p.emails.length > 0 : true));

  for (const p of rows) {
    const mark = p.repliedAt ? 'REPLIED' : p.emailedAt ? 'emailed' : '';
    console.log(`${p.domain.padEnd(34)}${(p.emails[0] ?? STATUS_LABEL[p.status] ?? p.status).padEnd(34)}${mark}`);
    if (p.name) console.log(`  ${p.name}`);
  }

  const counts = all.reduce((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {});
  const emailed = all.filter((p) => p.emailedAt).length;
  const awaiting = all.filter((p) => p.emailedAt && !p.repliedAt && !p.followedUpAt
    && p.emails.length > 0 && p.status !== 'skip').length;
  console.log(`\n${rows.length} shown of ${all.length}. ` +
    Object.entries(counts).map(([k, v]) => `${STATUS_LABEL[k] ?? k}: ${v}`).join('  ') +
    `  |  emailed: ${emailed}  to follow up: ${awaiting}`);
}

/**
 * Catch the log up after a round sent by hand.
 *
 * Writing to people outside the tool is normal -- the first round usually
 * happens in Gmail -- and the log has no way to know. Without this, the next
 * `send` writes to all of them a second time, which is the one mistake that
 * actually costs a prospect.
 */
async function markEveryone(flags) {
  const all = await readProspects();
  const pending = all.filter((p) => p.emails.length > 0 && !p.emailedAt && p.status !== 'skip');

  if (pending.length === 0) {
    console.log('Everyone with an address is already marked emailed.');
    return;
  }
  if (!flags.yes) {
    console.log(`Would mark ${pending.length} as already emailed:\n`);
    for (const p of pending) console.log(`  ${p.emails[0].padEnd(38)}${p.name || p.domain}`);
    console.log(`\nNothing changed. To apply:  node prospects/cli.mjs mark --all --emailed --yes`);
    console.log('Undo any single one later with:  mark <domain> --unmark');
    return;
  }

  const now = new Date().toISOString();
  for (const p of pending) p.emailedAt = now;
  await writeProspects(all);
  console.log(`${pending.length} marked as emailed. They will not be written to again.`);
}

async function cmdMark(flags, positional) {
  if (flags.all) return markEveryone(flags);

  const domain = positional[0];
  if (!domain) throw new Error('Usage: mark <domain> --emailed | --replied | --skip | --unmark\n   or: mark --all --emailed');
  const now = new Date().toISOString();
  const changes = {};
  if (flags.emailed) changes.emailedAt = now;
  if (flags.replied) { changes.repliedAt = now; if (!flags.emailed) changes.emailedAt = changes.emailedAt ?? now; }
  if (flags.skip) changes.status = 'skip';
  if (flags.unmark) { changes.emailedAt = ''; changes.repliedAt = ''; }
  if (flags.note) changes.notes = String(flags.note);
  if (Object.keys(changes).length === 0) {
    throw new Error('Nothing to change. Pass --emailed, --replied, --skip, --unmark or --note.');
  }

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send the outreach mail to everyone who has not had it yet.
 *
 * Deliberately awkward to misuse:
 *
 * - nothing is sent without --send; the default prints what would go out
 * - one message per connection, with a pause between them, because a burst of
 *   near-identical mail is exactly the pattern that gets a Gmail account
 *   flagged and every future message filtered
 * - a capped batch, so a mistake costs a handful of messages rather than the
 *   whole list
 * - the outreach log is checked before each send and written after it, so an
 *   interrupted run never re-mails anyone
 */
async function cmdSend(flags) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const fromName = flags.name === true ? undefined : (flags.name ?? process.env.GMAIL_FROM_NAME);

  const followUp = Boolean(flags.followup);
  const all = await readProspects();
  const reachable = all.filter((p) => p.emails.length > 0 && p.status !== 'skip');
  // A follow-up goes to someone who has had the first message and not answered
  // it. Anyone who replied is out: they are a conversation now, not a queue.
  const waiting = followUp
    ? reachable.filter((p) => p.emailedAt && !p.repliedAt && !p.followedUpAt)
    : reachable.filter((p) => !p.emailedAt);
  const wanted = flags.people ? waiting.filter((p) => isPersonAddress(p.emails[0])) : waiting;
  // People before desks even without --people: a named address at a small
  // agency is usually the owner, and info@ is usually a customer-service queue
  // where a pitch gets closed as the wrong kind of enquiry. Costs nothing to
  // spend the daily cap on the better half first. Array.sort is stable, so
  // everything else keeps the order it had.
  const queue = [...wanted]
    .sort((a, b) => Number(isPersonAddress(b.emails[0])) - Number(isPersonAddress(a.emails[0])))
    .slice(0, num(flags.limit, 25));

  if (queue.length === 0) {
    if (flags.people && waiting.length > 0) {
      console.log(`No person-shaped addresses left. ${waiting.length} desk address${waiting.length === 1 ? '' : 'es'} waiting — drop --people to write to those.`);
    } else if (followUp) {
      console.log('Nobody to follow up with. Everyone who was emailed has replied, or has already had a second message.');
    } else {
      console.log('Nobody to write to. Everyone with an address has had it, or nothing has been looked up yet.');
    }
    return;
  }

  const delayMs = Math.max(0, num(flags.delay, 60)) * 1000;
  // The same records the page embeds, so both send an identical message. A
  // follow-up carries none, so it does not need them.
  const records = followUp ? [] : await loadSampleRecords();
  const messageFor = (p) => (followUp ? buildFollowUp(p.emails[0]) : buildBody(p.emails[0], records));
  const subjectFor = (p) => (followUp ? followUpSubject(p.messageId) : SUBJECT);

  if (!flags.send) {
    const people = queue.filter((p) => isPersonAddress(p.emails[0])).length;
    console.log(`Would ${followUp ? 'follow up with' : 'send to'} ${queue.length} (${people} to a person, ${queue.length - people} to a desk):\n`);
    for (const p of queue) {
      console.log(`  ${isPersonAddress(p.emails[0]) ? '*' : ' '} ${p.emails[0].padEnd(38)}${p.name || p.domain}`);
    }
    console.log(`\nSubject: ${subjectFor(queue[0])}`);
    console.log(`\n${messageFor(queue[0])}\n`);
    console.log(`That is the message ${queue[0].emails[0]} would get.`);
    console.log(`\nNothing was sent. To actually send:  node prospects/cli.mjs send${followUp ? ' --followup' : ''} --send`);
    if (!user || !pass) console.log('You will also need GMAIL_USER and GMAIL_APP_PASSWORD set.');
    return;
  }

  if (!user || !pass) {
    throw new Error(
      'Set your account first:\n' +
        '  export GMAIL_USER="you@gmail.com"\n' +
        '  export GMAIL_APP_PASSWORD="16-char app password"\n' +
        'The app password comes from myaccount.google.com/security (2-Step Verification must be on).',
    );
  }

  console.log(`Sending to ${queue.length}, one every ${delayMs / 1000}s. Ctrl-C stops it safely.\n`);
  let sent = 0;
  for (const [i, prospect] of queue.entries()) {
    const to = prospect.emails[0];
    process.stdout.write(`  ${String(i + 1).padStart(3)}/${queue.length}  ${to.padEnd(38)}`);
    try {
      const result = await sendMail({
        user, pass, fromName, to,
        subject: subjectFor(prospect),
        body: messageFor(prospect),
        // Only where the first message's id was recorded. Without it the
        // subject is not "Re:" either, so nothing claims a thread that the
        // recipient's client cannot show.
        inReplyTo: followUp ? (prospect.messageId || undefined) : undefined,
      });
      if (followUp) {
        prospect.followedUpAt = new Date().toISOString();
      } else {
        prospect.emailedAt = new Date().toISOString();
        prospect.messageId = result.messageId; // so a follow-up can thread onto it
      }
      sent++;
      console.log(followUp && prospect.messageId ? 'sent (threaded)' : 'sent');
    } catch (err) {
      prospect.notes = err.message.split('\n')[0];
      console.log(err instanceof SmtpError ? `failed — ${prospect.notes}` : `failed — ${err.message}`);
      // An auth failure will fail identically for everyone; stop rather than
      // hammer Gmail with the same bad credential.
      if (err instanceof SmtpError && [535, 534].includes(err.code)) {
        await writeProspects(all);
        throw new Error(err.message);
      }
    }
    await writeProspects(all); // after every message: a Ctrl-C must not lose the log
    if (i < queue.length - 1) await sleep(delayMs);
  }

  const left = all.filter((p) => p.emails.length > 0 && p.status !== 'skip'
    && (followUp ? p.emailedAt && !p.repliedAt && !p.followedUpAt : !p.emailedAt)).length;
  console.log(`\n${sent} sent. ${left} still to go — run it again tomorrow.`);
}

const USAGE = `
Find who to sell the list to

  node prospects/cli.mjs buyers           who might buy your data, and why
  node prospects/cli.mjs search --buyer insurance --area "Brooklyn NY"
  node prospects/cli.mjs add <file>        a .txt of URLs, or a CSV with a website column
  node prospects/cli.mjs find [--limit 25] look up contact addresses
  node prospects/cli.mjs list [--found] [--new] [--people]   what you have
  node prospects/cli.mjs mark <domain> --emailed | --replied | --skip | --unmark
  node prospects/cli.mjs mark --all --emailed     after a round sent by hand
  node prospects/cli.mjs export --csv out.csv

Needs a key for search:  export GOOGLE_PLACES_API_KEY=...
(console.cloud.google.com, enable "Places API (New)")

  node prospects/cli.mjs send [--limit 25] [--delay 60]   preview; add --send to really send
  node prospects/cli.mjs send --followup                 a second message to whoever never answered
  node prospects/cli.mjs send --people                   named humans only, skipping info@ and friends

Named addresses go first either way (marked * in the preview): info@ at an
agency is usually the queue that answers customers, not anyone who buys.

To send, also:
  export GMAIL_USER="you@gmail.com"
  export GMAIL_APP_PASSWORD="16-char app password"
(myaccount.google.com/security — 2-Step Verification must be on first)

Typical run:
  node prospects/cli.mjs search --buyer insurance --area "Brooklyn NY"
  node prospects/cli.mjs find
  node prospects/cli.mjs send                  # preview it
  node prospects/cli.mjs send --send           # then actually send

send and export both skip anyone already emailed, so nobody gets it twice.
`;

const COMMANDS = {
  buyers: cmdBuyers, search: cmdSearch, add: cmdAdd, find: cmdFind,
  list: cmdList, mark: cmdMark, export: cmdExport, send: cmdSend,
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
