// Client for the records feed.
//
// Record text (business names, streets) comes from a public portal: it is
// external input. Everything here builds DOM nodes and assigns textContent --
// there is no innerHTML on a data path, so a business registered as
// "<img onerror=...>" renders as those literal characters.

const $ = (id) => document.getElementById(id);
const FILTER_IDS = ['days', 'borough', 'category', 'status', 'contains'];

// A slice is worth selling at roughly 15/week; below ~8 it is not a product.
const VERDICTS = [
  { min: 15, tone: 'good', text: 'Enough volume to sell', short: 'sellable' },
  { min: 8, tone: 'warning', text: 'Thin — widen the category or add a borough', short: 'thin' },
  { min: 0, tone: 'critical', text: 'Too thin to build on', short: 'too thin' },
];

let currentQuery = '';
let lastWeeks = [];
let allSources = [];

// --- state <-> URL -----------------------------------------------------

function readControls() {
  const params = new URLSearchParams();
  params.set('source', $('source').value);
  for (const id of FILTER_IDS) {
    const value = $(id).value.trim();
    if (value && value !== '0') params.set(id, value);
  }
  return params;
}

function applyUrlToControls() {
  const params = new URLSearchParams(location.search);
  for (const id of ['source', ...FILTER_IDS]) {
    const value = params.get(id);
    if (value !== null) $(id).value = value;
  }
}

/** Keep a <select> usable even when the store has no such value (yet). */
function fillSelect(select, values, placeholder) {
  const previous = select.value;
  select.replaceChildren();
  const any = document.createElement('option');
  any.value = '';
  // A dropdown offering only "Any" looks broken. Say why it is empty: the
  // column carries no values, which usually means a stale field mapping.
  any.textContent = values.length === 0 && !previous ? 'none in this data' : placeholder;
  select.append(any);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  // A filter carried in from the URL may not appear in this source's data;
  // keep it selectable rather than silently resetting to "Any".
  if (previous && !values.includes(previous)) {
    const orphan = document.createElement('option');
    orphan.value = previous;
    orphan.textContent = `${previous} (not in this source)`;
    select.append(orphan);
  }
  select.value = previous;
  select.disabled = values.length === 0 && !previous;
}

// --- rendering ---------------------------------------------------------

function notice(text, tone = '') {
  const el = document.createElement('p');
  el.className = `banner ${tone}`.trim();
  el.textContent = text;
  return el;
}

function renderNotices(data) {
  const box = $('notices');
  box.replaceChildren();

  if (data.source.confidence !== 'verified') {
    box.append(notice(
      `Column names for ${data.source.dataset} are unverified (${data.source.confidence}). ` +
      `Run "node records/cli.mjs probe ${data.source.id}" and correct records/sources.mjs if anything reads BAD.`,
    ));
  }

  // A licence that has been voided or surrendered is not a new business. It is
  // a small share of rows and easy to miss, and shipping one to a buyer costs
  // more trust than the row was worth.
  if (data.dead?.count > 0) {
    box.append(notice(
      `${data.dead.count} of ${data.total.toLocaleString()} records are ` +
      `${data.dead.statuses.join(' or ')} — those licences are no longer live. ` +
      `Set Status to ${data.activeStatus} before exporting a lead list.`,
    ));
  }

  // A column blank in every single record is not a quiet gap in the data, it is
  // a broken mapping -- and the visible symptom is a filter with nothing in it,
  // which reads as a bug in the page rather than a problem with the store.
  const blank = (data.completeness ?? []).filter((c) => c.filled === 0);
  if (data.total > 0 && blank.length) {
    const names = blank.map((c) => c.field).join(', ');
    box.append(notice(
      `${names} ${blank.length === 1 ? 'is' : 'are'} blank in all ${data.total.toLocaleString()} records, ` +
      `so those filters have nothing to offer. This usually means the store was built with an older field ` +
      `mapping. Re-pull it:  rm -rf records/data  then  node records/cli.mjs pull ${data.source.id} --days 365`,
      'error',
    ));
  }
}

function renderVerdict(stats) {
  const hasWeeks = stats.weeks.length > 0;
  $('median').textContent = hasWeeks ? String(stats.median) : '—';

  const verdict = $('verdict');
  if (!hasWeeks) {
    verdict.className = 'verdict';
    verdict.textContent = 'Not enough complete weeks yet';
    return;
  }
  const { tone, text } = VERDICTS.find((v) => stats.median >= v.min);
  verdict.className = `verdict ${tone}`;
  verdict.textContent = text;
}

function renderTiles(data) {
  const { stats, total, rows } = data;
  $('total').textContent = total.toLocaleString();
  $('total-note').textContent =
    (total > rows.length ? `showing first ${rows.length}` : '') +
    (stats.undated ? `${total > rows.length ? ' · ' : ''}${stats.undated} undated` : '');

  if (stats.range) {
    $('range').textContent = `${stats.range.first} → ${stats.range.last}`;
    $('range-note').textContent = `${stats.range.days} days · ${stats.weeks.length} complete weeks`;
  } else {
    $('range').textContent = '—';
    $('range-note').textContent = '';
  }
}

/** Bar with a 4px rounded data-end, square where it meets the baseline. */
function barPath(x, y, w, h, r = 4) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}L${x},${y + rr}Q${x},${y} ${x + rr},${y}` +
    `L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h}Z`;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function niceMax(value) {
  if (value <= 5) return Math.max(2, Math.ceil(value / 2) * 2);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = magnitude / 2;
  let max = Math.ceil(value / step) * step;
  // Keep the midpoint gridline a whole number: a max of 55 labels its middle
  // tick "28", which reads like a data value rather than an axis.
  if (max % 2 !== 0) max += step;
  return max;
}

function renderChart(weeks) {
  const svg = $('chart');
  svg.replaceChildren();
  $('chart-empty').hidden = weeks.length > 0;
  if (weeks.length === 0) return;

  const width = svg.clientWidth || 900;
  const height = 260;
  const pad = { top: 12, right: 8, bottom: 26, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const max = niceMax(Math.max(...weeks.map((w) => w.count), 1));
  const yOf = (v) => pad.top + plotH - (v / max) * plotH;

  // Recessive hairline gridlines, solid, one step off the surface.
  for (const value of [0, max / 2, max]) {
    const y = yOf(value);
    svg.append(svgEl('line', {
      class: value === 0 ? 'axis-line' : 'grid-line',
      x1: pad.left, x2: width - pad.right, y1: y, y2: y,
    }));
    const tick = svgEl('text', { class: 'tick', x: pad.left - 8, y: y + 3.5, 'text-anchor': 'end' });
    tick.textContent = String(Math.round(value));
    svg.append(tick);
  }

  const band = plotW / weeks.length;
  const barW = Math.max(1, Math.min(24, band - 2)); // 2px surface gap between bars
  // Thin out x labels so they never collide, whatever the window width.
  const labelEvery = Math.max(1, Math.ceil(weeks.length / Math.max(1, Math.floor(plotW / 74))));

  weeks.forEach((week, i) => {
    const bandX = pad.left + i * band;
    const x = bandX + (band - barW) / 2;
    const y = yOf(week.count);
    const group = svgEl('g', { class: 'band' });

    // Hit target spans the full band height, so hovering never requires
    // landing on a 3px-tall bar (or on a zero week, which has no bar at all).
    group.append(svgEl('rect', { class: 'hit', x: bandX, y: pad.top, width: band, height: plotH }));
    if (week.count > 0) {
      group.append(svgEl('path', { class: 'bar', d: barPath(x, y, barW, pad.top + plotH - y) }));
    }

    group.addEventListener('pointerenter', () => showTip(week, bandX + band / 2, y));
    group.addEventListener('pointerleave', hideTip);
    svg.append(group);

    if (i % labelEvery === 0) {
      const label = svgEl('text', {
        class: 'tick', x: bandX + band / 2, y: height - 8, 'text-anchor': 'middle',
      });
      label.textContent = week.week.slice(5).replace('-', '/');
      svg.append(label);
    }
  });
}

function showTip(week, x, y) {
  const tip = $('tooltip');
  tip.replaceChildren();
  const value = document.createElement('b');
  value.textContent = `${week.count} record${week.count === 1 ? '' : 's'}`;
  const when = document.createElement('span');
  when.textContent = `week of ${week.week}`;
  tip.append(value, when);
  tip.hidden = false;
  // Offset by the chart padding so the tooltip tracks the bar, not the page.
  tip.style.left = `${x + 12}px`;
  tip.style.top = `${Math.max(y, 24) + 4}px`;
}

function hideTip() {
  $('tooltip').hidden = true;
}

/** One slice table: value, per-week rate, verdict. Rows apply the filter. */
function renderSlices(bodyId, filterId, entries, fillPct) {
  const body = $(bodyId);
  body.replaceChildren();
  const max = Math.max(...entries.map((e) => e.perWeek), 1);

  const note = $(`fill-${filterId}`);
  note.textContent = fillPct != null && fillPct < 100
    ? `recorded on ${Math.round(fillPct)}% of records`
    : '';

  for (const entry of entries) {
    const row = document.createElement('tr');
    const named = entry.value !== '';

    const label = document.createElement('td');
    label.className = 'slice-label';
    label.textContent = named ? entry.value : '(not recorded)';
    label.title = label.textContent;

    const rate = document.createElement('td');
    rate.className = 'slice-rate';
    rate.textContent = entry.perWeek.toLocaleString();

    const bar = document.createElement('td');
    bar.className = 'slice-bar';
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${(entry.perWeek / max) * 100}%`;
    track.append(fill);
    bar.append(track);

    const state = document.createElement('td');
    state.className = 'slice-state';
    if (named) {
      // Records with no value for this field are not a slice you can sell --
      // calling the blank row "sellable" invites filtering to nothing.
      const { tone, short } = VERDICTS.find((v) => entry.perWeek >= v.min);
      state.className = `slice-state verdict ${tone}`;
      state.textContent = short;
    }

    row.append(label, rate, bar, state);
    if (named) {
      row.tabIndex = 0;
      row.className = 'clickable';
      row.title = `Filter to ${entry.value}`;
      const apply = () => {
        $(filterId).value = entry.value;
        refresh();
      };
      row.addEventListener('click', apply);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
      });
    }
    body.append(row);
  }
}

function renderTable(rows, total, columns) {
  const head = $('head-row');
  head.replaceChildren();
  for (const [, title] of columns) {
    const th = document.createElement('th');
    th.textContent = title;
    head.append(th);
  }

  const body = $('body-rows');
  body.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const [key] of columns) {
      const td = document.createElement('td');
      td.className = key;
      td.textContent = row[key] ?? ''; // never innerHTML: this is portal data
      tr.append(td);
    }
    body.append(tr);
  }

  $('no-rows').hidden = rows.length > 0;
  $('table-note').textContent =
    rows.length === 0 ? '' :
    total > rows.length ? `Showing ${rows.length} of ${total.toLocaleString()} — the CSV has all of them.`
      : `${total.toLocaleString()} record${total === 1 ? '' : 's'}.`;
}

// --- data --------------------------------------------------------------

async function loadSources() {
  const res = await fetch('/api/sources');
  if (!res.ok) throw new Error('Could not reach the server');
  const { sources } = await res.json();

  allSources = sources;
  const select = $('source');
  select.replaceChildren();
  for (const source of sources) {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = source.count
      ? `${source.label} (${source.count.toLocaleString()})`
      : `${source.label} — no data`;
    select.append(option);
  }
  return sources;
}

async function refresh({ push = true } = {}) {
  const params = readControls();
  const query = params.toString();
  currentQuery = query;
  if (push) history.replaceState(null, '', `?${query}${location.hash}`);

  let data;
  try {
    const res = await fetch(`/api/feed?${query}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  } catch (err) {
    $('error').textContent = err.message;
    $('error').hidden = false;
    return;
  }
  // A slower earlier request must not overwrite a newer render.
  if (query !== currentQuery) return;
  $('error').hidden = true;

  renderNotices(data);

  $('empty').hidden = !data.empty;
  $('content').hidden = data.empty;
  // Filters against an empty store are all "Any" with nothing behind them,
  // which reads as a broken page rather than an empty one.
  $('filters').hidden = data.empty;
  if (data.empty) {
    $('empty-cmd').textContent = data.pullCommand;
    const elsewhere = allSources.filter((s) => s.id !== data.source.id && s.count > 0);
    const hint = $('empty-other');
    hint.replaceChildren();
    if (elsewhere.length) {
      hint.append(
        `Other sources do have data — switch with the Source menu above: ` +
        elsewhere.map((s) => `${s.label} (${s.count.toLocaleString()})`).join(', '),
      );
    }
    hint.hidden = elsewhere.length === 0;
    return;
  }

  fillSelect($('borough'), data.options.borough, 'Any');
  fillSelect($('category'), data.options.category, 'Any');
  fillSelect($('status'), data.options.status, 'Any');

  renderVerdict(data.stats);
  renderTiles(data);
  lastWeeks = data.stats.weeks;
  renderChart(lastWeeks);
  const fill = (field) => data.completeness.find((c) => c.field === field)?.pct;
  renderSlices('slice-category', 'category', data.slices.category, fill('category'));
  renderSlices('slice-borough', 'borough', data.slices.borough, fill('borough'));
  renderTable(data.rows, data.total, data.columns);
  $('download').href = `/api/export.csv?${query}`;
}

// --- prospects ---------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}`);
  return data;
}

const PROSPECT_STATE = {
  pending: 'not looked up',
  ok: '',
  'no-email': 'no address on site',
  unreachable: 'site unreachable',
  'bad-url': 'bad address',
  skip: 'skipped',
};

let buyers = [];
let chosenBuyer = null;
let searchReady = false;

const NO_KEY =
  'Searching needs a Google Places key. In your terminal: export GOOGLE_PLACES_API_KEY=your_key, ' +
  'then restart the server. Until then, paste websites below.';

function renderBuyers(list, ready) {
  if (list?.length) buyers = list;
  searchReady = Boolean(ready);
  // Without a key the search cannot work, so do not offer it as if it could.
  $('buyer-search').disabled = !searchReady;
  const row = $('buyer-row');
  if (row.childElementCount > 0) return; // built once; selection is just a class
  for (const buyer of buyers) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'buyer';
    chip.textContent = buyer.label;
    chip.addEventListener('click', () => {
      chosenBuyer = chosenBuyer === buyer.id ? null : buyer.id;
      for (const other of row.children) other.classList.toggle('on', other === chip && chosenBuyer);
      // Typing your own search and picking a preset are the same field; a
      // preset wins, so clear the box rather than leaving two live inputs.
      if (chosenBuyer) $('buyer-query').value = '';
      // The missing-key note has to survive picking a buyer -- it is the thing
      // standing between them and a working search.
      const why = chosenBuyer ? buyer.why : '';
      $('buyer-why').textContent = searchReady ? why : [why, NO_KEY].filter(Boolean).join(' — ');
    });
    row.append(chip);
  }
  if (!searchReady) $('buyer-why').textContent = NO_KEY;
}

function renderProspects(data) {
  const { prospects, counts } = data;
  renderBuyers(data.buyers, data.searchReady);
  $('pc-total').textContent = counts.total.toLocaleString();
  $('pc-email').textContent = counts.withEmail.toLocaleString();
  $('pc-pending').textContent = counts.pending ? `${counts.pending} not looked up yet` : '';
  $('pc-emailed').textContent = counts.emailed.toLocaleString();
  $('pc-replied').textContent = counts.replied ? `${counts.replied} replied` : '';
  $('prospect-find').disabled = counts.pending === 0;
  $('prospect-empty').hidden = prospects.length > 0;

  const body = $('prospect-rows');
  body.replaceChildren();

  // Worth doing first at the top: no address yet, then found-but-unsent, then
  // the ones already handled.
  const rank = (p) => (p.repliedAt ? 3 : p.emailedAt ? 2 : p.emails.length ? 0 : 1);
  for (const p of [...prospects].sort((a, b) => rank(a) - rank(b) || a.domain.localeCompare(b.domain))) {
    const tr = document.createElement('tr');

    const who = document.createElement('td');
    who.className = 'name';
    const label = document.createElement('div');
    label.textContent = p.name || p.domain; // portal-free, but still not ours: textContent
    const host = document.createElement('a');
    host.href = p.url;
    host.target = '_blank';
    host.rel = 'noopener noreferrer';
    host.className = 'muted-link';
    host.textContent = p.domain;
    who.append(label, host);

    const contact = document.createElement('td');
    if (p.emails.length) {
      const mail = document.createElement('a');
      mail.href = `mailto:${p.emails[0]}`;
      mail.textContent = p.emails[0];
      contact.append(mail);
      if (p.emails.length > 1) {
        const extra = document.createElement('span');
        extra.className = 'muted';
        extra.textContent = ` +${p.emails.length - 1} more`;
        contact.append(extra);
      }
    } else {
      contact.className = 'muted';
      contact.textContent = PROSPECT_STATE[p.status] ?? p.status;
    }

    const state = document.createElement('td');
    state.className = 'slice-state';
    if (p.repliedAt) { state.classList.add('verdict', 'good'); state.textContent = 'replied'; }
    else if (p.emailedAt) { state.textContent = 'emailed'; state.classList.add('muted'); }

    const actions = document.createElement('td');
    actions.className = 'row-actions';
    const act = (text, action, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost tiny';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          renderProspects(await api('/api/prospects/mark', { domain: p.domain, action }));
        } catch (err) {
          showError(err.message);
          b.disabled = false;
        }
      });
      return b;
    };
    if (p.repliedAt || p.emailedAt) actions.append(act('undo', 'unmark', 'Clear this'));
    else if (p.emails.length) {
      actions.append(act('emailed', 'emailed', 'Mark as written to'));
      actions.append(act('replied', 'replied', 'They wrote back'));
    } else if (p.status !== 'skip' && p.status !== 'pending') {
      // No address to write to, so the only useful verdict is to stop
      // considering it.
      actions.append(act('skip', 'skip', 'Stop showing this one as work to do'));
    }
    tr.append(who, contact, state, actions);
    body.append(tr);
  }
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

async function refreshProspects() {
  try {
    $('error').hidden = true;
    renderProspects(await api('/api/prospects'));
  } catch (err) {
    showError(err.message);
  }
}

function wireProspects() {
  $('prospect-add').addEventListener('click', async () => {
    const text = $('prospect-input').value;
    if (text.trim() === '') return;
    const button = $('prospect-add');
    button.disabled = true;
    try {
      const data = await api('/api/prospects/add', { text });
      $('prospect-input').value = '';
      $('prospect-status').textContent = `${data.added} added, ${data.skipped} already known`;
      renderProspects(data);
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  });

  const runSearch = async () => {
    const button = $('buyer-search');
    const query = $('buyer-query').value.trim();
    if (!chosenBuyer && !query) {
      $('prospect-status').textContent = 'Pick a buyer above, or type what to search for.';
      return;
    }
    button.disabled = true;
    $('prospect-status').textContent = 'Searching Google Places…';
    try {
      const data = await api('/api/prospects/search', {
        buyer: chosenBuyer, query, area: $('buyer-area').value.trim(),
      });
      $('prospect-status').textContent =
        `${data.searched} found · ${data.added} new · ${data.skipped} already known` +
        (data.withoutWebsite ? ` · ${data.withoutWebsite} had no website` : '');
      renderProspects(data);
    } catch (err) {
      showError(err.message);
      $('prospect-status').textContent = '';
    } finally {
      button.disabled = false;
    }
  };
  $('buyer-search').addEventListener('click', runSearch);
  $('buyer-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('buyer-area').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('buyer-query').addEventListener('input', () => {
    // Typing your own query drops the preset, so only one of them is ever live.
    if ($('buyer-query').value.trim() && chosenBuyer) {
      chosenBuyer = null;
      for (const chip of $('buyer-row').children) chip.classList.remove('on');
      $('buyer-why').textContent = '';
    }
  });

  $('prospect-find').addEventListener('click', async () => {
    const button = $('prospect-find');
    button.disabled = true;
    // Each site is fetched slowly on purpose, so say so rather than looking hung.
    $('prospect-status').textContent = 'Visiting sites… a few seconds each';
    try {
      const data = await api('/api/prospects/find', {});
      $('prospect-status').textContent =
        `Looked up ${data.crawled}. ${data.counts.pending} left.`;
      renderProspects(data);
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

// --- views ---------------------------------------------------------------

function showView(name) {
  const view = name === 'prospects' ? 'prospects' : 'records';
  $('view-records').hidden = view !== 'records';
  $('view-prospects').hidden = view !== 'prospects';
  // The source picker belongs to the records view only.
  $('source-field').hidden = view !== 'records';
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.view === view;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}${view === 'records' ? location.search : ''}`);
  if (view === 'prospects') refreshProspects();
}

// --- wiring ------------------------------------------------------------

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function main() {
  const theme = $('theme');
  theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;

  const sources = await loadSources();
  applyUrlToControls();
  // Without this the page opens on the first source in the list, which is
  // usually the one you have not pulled -- every filter empty and no clue why.
  if (!new URLSearchParams(location.search).get('source')) {
    const withData = sources.find((s) => s.count > 0);
    if (withData) $('source').value = withData.id;
  }

  $('source').addEventListener('change', () => refresh());
  for (const id of ['days', 'borough', 'category', 'status']) {
    $(id).addEventListener('change', () => refresh());
  }
  $('contains').addEventListener('input', debounce(() => refresh(), 220));
  $('reset').addEventListener('click', () => {
    for (const id of FILTER_IDS) $(id).value = id === 'days' ? '90' : '';
    refresh();
  });

  // The chart is laid out in real pixels, so it has to be redrawn on resize --
  // but that is a repaint, not a data change, so it must not refetch.
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width && width !== lastWidth) {
      lastWidth = width;
      if (lastWeeks.length) renderChart(lastWeeks);
    }
  }).observe($('chart').parentElement);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  }
  wireProspects();

  await refresh({ push: false });
  showView(location.hash.slice(1) === 'prospects' ? 'prospects' : 'records');
}

main().catch((err) => {
  $('error').textContent = `${err.message}. Is the server still running?`;
  $('error').hidden = false;
});
