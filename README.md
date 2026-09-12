# finder

Watches NYC public records for newly licensed and newly permitted businesses,
dedupes them, and turns a filtered slice into a daily feed — browsable in a
local web UI or scriptable from the CLI.

The premise: a business that just got licensed has no vendors yet. Whoever
reaches it first — bookkeeper, insurer, POS reseller, supplier — wants to know.
The records are public and free, but they sit behind clunky portals that nobody
watches continuously. This watches them.

## Column names are verified

The Socrata column names in `records/sources.mjs` were checked against the live
datasets with `probe` on 2026-09-11. Portals do reshape datasets, so if a pull
starts refusing batches, re-check:

```bash
node records/cli.mjs probe --all
```

It fetches one row per dataset and prints `ok` or `BAD` for every column this
repo declares, followed by the dataset's real column list. Fixing a wrong name
is a one-line edit to the `fields` map in `records/sources.mjs` — nothing else
in the codebase hardcodes a portal column name.

`pull` also refuses to write a batch whose required fields come back empty,
rather than overwriting a good store with thousands of blank rows.

## Quickstart

```bash
node records/cli.mjs probe --all                      # 1. verify the mapping
node records/cli.mjs pull dcwp-licenses --days 180    # 2. fetch history
npm run web                                           # 3. browse it
```

Then open **http://localhost:4000**.

No dependencies. Node 20+.

## If a filter dropdown is empty

A filter offering only "Any" means that column is blank in every stored record.
The page now says so and names the fix, but the cause is almost always this:

**Upgrading the code does not repair rows already on disk.** If you pulled data
with an older, wrong field mapping, those rows keep their blank columns forever.
Delete the store and pull again:

```bash
rm -rf records/data
node records/cli.mjs pull dcwp-licenses --days 365
```

## The web UI

`npm run web` serves a local page for slicing the data and exporting leads:

- **Median per week**, with a verdict — whether the current slice has enough
  volume to sell, recomputed as you filter
- **Weekly volume chart** over complete weeks, with per-week hover
- **Filters** for window, borough, category, status, and free text; the URL
  carries them, so a promising slice can be bookmarked
- **Breakdowns** by borough and category
- **Download CSV** of the current slice — the table caps at 500 rows for speed,
  the export never does

```bash
npm run web -- --port 4123    # if 4000 is taken
PORT=4123 npm run web         # same thing
```

It binds to `127.0.0.1` only. The store holds contact-adjacent business data and
the server has no authentication, so it is deliberately not reachable from the
rest of your network.

### CLI equivalents

Everything in the UI is available headless, which is what a scheduled job wants:

```bash
node records/cli.mjs stats dcwp-licenses --borough Queens --category "Home Improvement"
node records/cli.mjs digest dcwp-licenses --days 7 --csv leads.csv
```

## The command that matters

`stats` is the one that answers the actual question — whether a slice is worth
building a product on:

```
MEDIAN 40 per week   (mean 40.8, over 17 complete weeks)
```

It reports a median over **complete Monday–Sunday weeks only**. The first and
last week of any pull are partial by construction, and counting them drags the
figure down and makes a healthy feed look dead. Weeks with genuinely zero
records are counted as real zeros, because those droughts are the thing that
kills a feed and hiding them would be flattering.

Rule of thumb: under ~15/week a slice is too thin to sell on its own. Widen the
category or add a borough.

## Sources

| id | what | why it's interesting |
|---|---|---|
| `dcwp-applications` | DCWP license applications | Earliest signal — applied, not yet open, no vendors. Filter `status` to pending. |
| `dcwp-licenses` | DCWP issued licenses | Cleanest history, widest industry coverage |
| `dob-permits` | DOB permit issuance | Different buyer: subs, equipment rental, dumpsters |

Adding a source is a new entry in `SOURCES` — an id, the dataset's 4-4 code, its
date column, and a field map. Then probe it.

## Rate limits

Anonymous requests get throttled. A free app token from
https://data.cityofnewyork.us/profile/edit/developer_settings lifts the cap:

```bash
export SOCRATA_APP_TOKEN=your_token
```

## Layout

```
records/
  sources.mjs    dataset definitions + field maps  <- the only file with portal column names
  socrata.mjs    fetch, pagination, staleness guard
  normalize.mjs  calendar-day and week arithmetic
  store.mjs      JSONL store, dedupe, atomic writes
  digest.mjs     filtering, weekly stats, CSV
  cli.mjs        command dispatch
web/
  server.mjs     HTTP server + JSON API (loopback only)
  index.html     page structure
  style.css      palette, light/dark
  app.js         fetch + render (textContent only -- see below)
```

The web layer reads the same store and calls the same `digest.mjs` functions the
CLI does, so the two can never disagree about what a number means.

Data lands in `records/data/*.jsonl`, which is gitignored — it's derived, and
re-pullable.

## Testing

```bash
npm test
```

The suite targets the failures that don't throw an exception — the ones that
just produce quietly wrong numbers:

- `$offset` paging without a stable `$order`, which skips and duplicates rows
- a SoQL timestamp carrying a `Z`, which the portal rejects
- a floating timestamp shifting a record a day west of UTC
- Sunday bucketing into the wrong week and splitting every weekend
- partial weeks at the edges faking a volume drought
- `=Best Cuts` executing as a formula when the lead CSV opens in Excel
- a renamed column silently blanking the store
- filter dropdowns rebuilt from filtered rows, which deletes every other option
  the moment you pick one
- the CSV export inheriting the table's 500-row display cap

Business names come from a public portal, so they are external input. The client
builds DOM nodes and assigns `textContent` — there is no `innerHTML` on any data
path, and a record named `<img src=x onerror=...>` renders as those literal
characters. There is a test for it, and it was verified in a real browser.

Every command also runs offline against a fixture, which is how the pipeline
gets exercised without network:

```bash
node records/cli.mjs pull dcwp-licenses --fixture path/to/rows.json
```

## Before you sell this

- **Public records are public.** Business name, address, license type and
  status are published by the city and fine to redistribute.
- **`contact_phone` is the field to think about.** It is in the public dataset
  and it is what makes a lead list worth paying for. It is also the field that
  turns the product into a calling list — and for individual licensees (a
  "Home Improvement Salesperson" is a person, not a company) it is often a
  personal cell. Selling it is legal; the telemarketing rules land on whoever
  dials, which is your buyer, not you. Drop `phone` from the `fields` map in
  `records/sources.mjs` if you would rather not ship it at all.
- **CAN-SPAM applies** to any email you send to people who didn't sign up.
- **Payment processors require account holders to be 18+.** Stripe, PayPal and
  Square all do, because contracts with a minor are voidable. The normal
  arrangement is a parent as the account holder while you run everything. That
  only matters at the moment someone first pays — building, running, and
  publishing a free feed needs no one's permission.
