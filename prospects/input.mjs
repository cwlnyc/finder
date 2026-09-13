// Reading a list of businesses from whatever file you happen to have.

import { normalizeUrl, siteDomain } from './crawl.mjs';

export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/**
 * Read sites from a plain list of URLs or from a CSV.
 *
 * Accepts whatever Mason or a copy-paste from Maps produces: the CSV branch
 * looks for a column named like a website and one named like a business, in
 * any order, rather than demanding a fixed layout.
 */
export function parseSiteFile(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const urlCol = header.findIndex((h) => /^(website|url|site|web|link|domain)$/.test(h));
  const nameCol = header.findIndex((h) => /^(name|business|company|title)$/.test(h));

  const rows = urlCol === -1
    ? lines.map((line) => ({ raw: line, name: '' }))
    : lines.slice(1).map((line) => {
        const cells = splitCsvLine(line);
        return { raw: (cells[urlCol] ?? '').trim(), name: nameCol === -1 ? '' : (cells[nameCol] ?? '').trim() };
      });

  const seen = new Set();
  const sites = [];
  for (const { raw, name } of rows) {
    const url = normalizeUrl(raw);
    const domain = siteDomain(url);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    sites.push({ url, domain, name });
  }
  return sites;
}

