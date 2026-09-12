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

It samples 200 rows per dataset and reports, for every column this repo maps,
whether it exists **and how often it actually carries a value**:

```
  field       column                    state    filled  example
  name        business_name             ok        100%   ASTORIA DELI
  category    business_category         EMPTY       0%
  licenseType license_type              ok        100%   Sidewalk Cafe
  expires     lic_expir_dd              MISSING      -
```

`MISSING` is a wrong column name. `EMPTY` is the right name on a column nobody
fills — a slower failure, because the pull succeeds and the store quietly fills
with blanks. It then lists populated columns you have not mapped, which is
usually where the value you wanted actually lives.

Fixing either is a one-line edit to the `fields` map in `records/sources.mjs`
— nothing else in the codebase hardcodes a portal column name.

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

## The export is cleaned, not raw

The portal publishes SHOUTING NAMES, three phone formats in one column, and an
address split across two. Cleaning that up is the product — otherwise the buyer
does it themselves and wonders what they paid for. `digest --csv` and the web
download both apply:

| Raw | Exported |
|---|---|
| `BREAD WINNERS CONSTRUCTION LLC` | `Bread Winners Construction LLC` |
| `GreyStone Contracting NY Corp` | unchanged — deliberate casing is left alone |
| `3474588357`, `(347) 426-7055` | `(347) 458-8357`, `(347) 426-7055` |
| `building` + `street` columns | one `Address` column |
| `licenseType` = "Premises" ×500 | dropped — a uniform column is padding |
| header `date,name,zip` | header `Date,Business,ZIP` |

Two details worth knowing:

- A ZIP like `07728` is written `'07728`. Without the apostrophe Excel reads it
  as the number 7728 and eats the leading zero; Excel and Sheets both strip the
  apostrophe on display.
- Only ALL-CAPS values are title-cased. Filter values (borough, category) and
  the stored data are never rewritten — cleaning happens on the way out.

## Borough is filled in from the ZIP

DCWP leaves `address_borough` blank on roughly a third of records. Every blank
one turns out to be a business outside the five boroughs — Yonkers, Long
Island, New Jersey, upstate. A blank cell reads as missing data; what it means
is "not in NYC".

`records/nyc.mjs` fills a blank borough from the ZIP: the borough for a city
ZIP, `Outside NYC` for a valid ZIP beyond it, and nothing at all when the ZIP
is missing or malformed — unknown is not the same as outside. A borough the
portal actually recorded is never overwritten.

This runs when rows are **read**, not when they are written, so a store pulled
before this existed gets the benefit without being re-downloaded.

The effect: borough goes from ~63% filled to 100%, those rows become
filterable, and "Outside NYC" becomes a slice you can sell separately — a New
Jersey contractor newly licensed to work in NYC is its own buying moment.

## Dead licences

`dcwp-licenses` declares `activeStatus: 'Active'`. Anything else — `Voided`,
`Surrendered` — is a licence that is no longer live, and the page says so:

> 3 of 242 records are Surrendered or Voided — those licences are no longer
> live. Set Status to Active before exporting a lead list.

They are about 1% of rows, easy to miss, and one of them reaching a buyer costs
more trust than the row was worth. The filter is left alone rather than
defaulted, so nothing disappears without you asking — but set Status to Active
before any export you intend to sell.

Sources without a single "live" status (DOB permits, whose filing statuses are
legitimately mixed) omit `activeStatus` and get no warning.

## Finding who to sell it to

`prospects/` is the other half: the contractor list is what you sell, this finds
the people who buy it (insurance brokers, suppliers, bookkeepers).

Google Maps — or any tool that lists local businesses — gives you names and
websites but **never email addresses**; no such field exists in the Places API.
This turns those websites into contact addresses.

```bash
node prospects/cli.mjs add brokers.csv      # a .txt of URLs, or a CSV with a website column
node prospects/cli.mjs find                 # visit each site, pull contact addresses
node prospects/cli.mjs list --found
node prospects/cli.mjs export --csv send.csv
# ...send the mail, then...
node prospects/cli.mjs mark sterlingins.com --emailed
```

`export` skips anyone already marked emailed, so nobody gets the same message
twice. That log is the point of the whole thing.

### What it does and does not do

- Reads `mailto:` links first, then page text, and understands
  `info [at] acme [dot] com`.
- Throws away what only looks like an address: `logo@2x.png`, Sentry keys,
  `you@example.com` template placeholders, `noreply@`. A prospect list padded
  with junk is worse than a short one — you find out after you have sent.
- Follows at most four contact-ish pages per site, same host only, and never
  wanders into a linked Facebook or blog.
- **Respects robots.txt**, waits ~1.2s between requests, and gives up on a slow
  site rather than hanging.

These limits are deliberate. The targets are small firms on shared hosting, and
finding twenty contacts is not worth degrading someone's website.

### Before you email anyone

Business contact addresses published on a company's own website, used for B2B
outreach, are fair game — but CAN-SPAM still applies: use a real name and reply
address, say who you are, and honour an opt-out immediately and permanently.
Keep this list separate from the contractor records. One is public record you
can sell; the other is your own working notes and is not for resale.

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
