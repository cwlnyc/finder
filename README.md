# finder

Watches NYC public records for newly licensed and newly permitted businesses,
dedupes them, and turns a filtered slice into a daily feed.

The premise: a business that just got licensed has no vendors yet. Whoever
reaches it first — bookkeeper, insurer, POS reseller, supplier — wants to know.
The records are public and free, but they sit behind clunky portals that nobody
watches continuously. This watches them.

## Read this before you trust a pull

**The Socrata column names in `records/sources.mjs` are unverified.** They were
written in a sandbox with no route to `data.cityofnewyork.us`, so they are
informed guesses. Some are probably wrong.

That is why `probe` exists. Run it first:

```bash
node records/cli.mjs probe --all
```

It fetches one row per dataset and prints `ok` or `BAD` for every column this
repo declares, followed by the dataset's real column list. Fixing a wrong name
is a one-line edit to the `fields` map in `records/sources.mjs` — nothing else
in the codebase hardcodes a portal column name.

If a name is wrong and you skip the probe, `pull` still refuses to write: it
checks each batch and aborts if the required fields come back empty, rather than
overwriting a good store with thousands of blank rows.

## Quickstart

```bash
node records/cli.mjs probe --all                      # 1. verify the mapping
node records/cli.mjs pull dcwp-licenses --days 180    # 2. fetch history
node records/cli.mjs stats dcwp-licenses              # 3. is there enough volume?
node records/cli.mjs stats dcwp-licenses --borough Queens --category "Home Improvement"
node records/cli.mjs digest dcwp-licenses --days 7 --csv leads.csv
```

No dependencies. Node 20+.

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
| `dcwp-applications` | DCWP license applications | Earliest signal — applied, not yet open, no vendors |
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
```

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

Every command also runs offline against a fixture, which is how the pipeline
gets exercised without network:

```bash
node records/cli.mjs pull dcwp-licenses --fixture path/to/rows.json
```

## Before you sell this

- **Public records are public.** Business name, business address, license type —
  fine to redistribute. Keep it to business information rather than anything
  that reads as a personal phone number.
- **CAN-SPAM applies** to any email you send to people who didn't sign up.
- **Payment processors require account holders to be 18+.** Stripe, PayPal and
  Square all do, because contracts with a minor are voidable. The normal
  arrangement is a parent as the account holder while you run everything. That
  only matters at the moment someone first pays — building, running, and
  publishing a free feed needs no one's permission.
