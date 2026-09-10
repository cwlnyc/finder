// Append-only JSONL store, one file per source.
//
// A flat file is the right size for this: tens of thousands of rows per source,
// read once per run, and greppable when something looks wrong. Swap it for a
// database when there is a paying customer, not before.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

export function storePath(sourceId, dir = DATA_DIR) {
  return join(dir, `${sourceId}.jsonl`);
}

export async function readStore(sourceId, dir = DATA_DIR) {
  const path = storePath(sourceId, dir);
  if (!existsSync(path)) return [];

  const text = await readFile(path, 'utf8');
  const rows = [];
  for (const [i, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // One torn line (killed mid-write, disk full) should not cost the file.
      process.emitWarning(`Skipping unparseable line ${i + 1} of ${path}`);
    }
  }
  return rows;
}

async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  // Rename is atomic within a filesystem, so a crash leaves either the old
  // file or the new one -- never a half-written store.
  await rename(tmp, path);
}

/**
 * Merge `incoming` into the stored rows, keyed by `id`.
 *
 * Rows already present are updated in place rather than appended (a license can
 * change status), and `firstSeen` is preserved from the original sighting so
 * re-pulling an overlapping window never re-reports an old business as new.
 */
export async function mergeStore(sourceId, incoming, { dir = DATA_DIR, now } = {}) {
  const existing = await readStore(sourceId, dir);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const stamp = now ?? new Date().toISOString();

  let added = 0;
  let updated = 0;
  for (const row of incoming) {
    if (!row.id) continue; // unkeyed row: cannot dedupe it, so don't store it
    const prior = byId.get(row.id);
    if (prior) {
      const merged = { ...prior, ...row, firstSeen: prior.firstSeen };
      if (JSON.stringify(merged) !== JSON.stringify(prior)) {
        byId.set(row.id, merged);
        updated++;
      }
    } else {
      byId.set(row.id, { ...row, firstSeen: stamp });
      added++;
    }
  }

  const all = [...byId.values()].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  await writeAtomic(storePath(sourceId, dir), all.map((r) => JSON.stringify(r)).join('\n') + '\n');

  return { added, updated, unchanged: incoming.length - added - updated, total: all.length };
}
