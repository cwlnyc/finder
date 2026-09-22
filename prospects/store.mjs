// Prospect list, keyed by domain.
//
// Deliberately separate from records/store.mjs. Records are immutable public
// facts; a prospect carries mutable state you edit -- crawled, emailed,
// replied, skip -- and merging the two would mean one of them compromising.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

export const STATUSES = ['pending', 'ok', 'no-email', 'unreachable', 'bad-url', 'skip'];

export function storePath(dir = DATA_DIR) {
  return join(dir, 'prospects.jsonl');
}

export async function readProspects(dir = DATA_DIR) {
  const path = storePath(dir);
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      process.emitWarning(`Skipping unparseable line in ${path}`);
    }
  }
  return rows;
}

export async function writeProspects(rows, dir = DATA_DIR) {
  const path = storePath(dir);
  await mkdir(dirname(path), { recursive: true });
  const sorted = [...rows].sort((a, b) => a.domain.localeCompare(b.domain));
  const tmp = `${path}.tmp`;
  await writeFile(tmp, sorted.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  await rename(tmp, path);
  return sorted;
}

/**
 * Add sites to the list, keyed by domain so the same business added twice --
 * from a re-run, or from two different searches -- is one row, not two.
 * A name is filled in if we did not have one; nothing else is overwritten.
 */
export async function addSites(sites, { dir = DATA_DIR, now } = {}) {
  const existing = await readProspects(dir);
  const byDomain = new Map(existing.map((p) => [p.domain, p]));
  const stamp = now ?? new Date().toISOString();
  let added = 0;
  let skipped = 0;

  for (const site of sites) {
    if (!site.domain) { skipped++; continue; }
    const prior = byDomain.get(site.domain);
    if (prior) {
      if (!prior.name && site.name) prior.name = site.name;
      skipped++;
      continue;
    }
    byDomain.set(site.domain, {
      domain: site.domain,
      url: site.url,
      name: site.name ?? '',
      status: 'pending',
      emails: [],
      addedAt: stamp,
      crawledAt: '',
      emailedAt: '',
      repliedAt: '',
      notes: '',
    });
    added++;
  }

  await writeProspects([...byDomain.values()], dir);
  return { added, skipped, total: byDomain.size };
}

/**
 * The prospects an export should contain: has an address, not yet written to,
 * and each address only once.
 *
 * Two cleanups that matter more than they look:
 *
 * - Places lists one firm under several entries -- a product landing page and
 *   the firm's own site -- which are different domains sharing one inbox.
 *   Deduping by domain alone lets the same person be mailed twice, which is
 *   precisely what the outreach log exists to prevent.
 * - Addresses on somebody else's domain were on the page but are not this
 *   business's. A broker's claims page lists the intake desk of every insurer
 *   they file with, and mailing a pitch to Chubb's claims queue is worse than
 *   sending nothing.
 */
export function exportable(prospects) {
  const seenEmail = new Set();
  const out = [];
  for (const p of prospects) {
    if (p.emails.length === 0 || p.emailedAt) continue;
    const primary = p.emails[0];
    const key = primary.toLowerCase();
    if (seenEmail.has(key)) continue;
    seenEmail.add(key);
    out.push({
      ...p,
      primary,
      others: p.emails.slice(1).filter((e) => e.toLowerCase().endsWith(`@${p.domain.toLowerCase()}`)),
    });
  }
  return out;
}

/** Apply `changes` to one prospect, matched by domain or a unique prefix. */
export async function updateProspect(match, changes, { dir = DATA_DIR } = {}) {
  const rows = await readProspects(dir);
  const needle = String(match).toLowerCase().replace(/^www\./, '');
  // An address or an address's domain counts too. The send preview lists
  // addresses rather than sites, so skipping a wrong-fit one straight off that
  // list has to work -- and a captive agent's mail usually sits on a carrier
  // domain with no relation to the website we crawled.
  const hits = rows.filter((r) => r.domain === needle
    || r.domain.startsWith(needle)
    || r.emails.some((e) => {
      const address = String(e).toLowerCase();
      return address === needle || address.slice(address.indexOf('@') + 1) === needle;
    }));
  if (hits.length === 0) {
    throw new Error(`No prospect matching '${match}'. Try the address itself, or a domain from: list --new`);
  }
  if (hits.length > 1) {
    throw new Error(`'${match}' matches ${hits.length}: ${hits.map((h) => h.domain).join(', ')}`);
  }
  Object.assign(hits[0], changes);
  await writeProspects(rows, dir);
  return hits[0];
}
