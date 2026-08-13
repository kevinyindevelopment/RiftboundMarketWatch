# Riftbound Market Watch

TCGplayer price tracking for every released Riftbound card. Sibling to
[RiftboundElo](https://kevin-yin.com/riftelo); will be served at
`kevin-yin.com/riftmarket`.

**Live:** <https://kevin-yin.com/riftmarket>

## Data at a glance

As of 2026-08-13:

| | |
| --- | --- |
| Sets | 10 |
| Singles | 1,479 (1,431 with a live price) |
| Sealed products | 55 |
| Price history | **91 days** (2026-05-15 →), 154,820 snapshots |
| Prices per day | ~1,993 (657 Normal + 1,336 Foil) |
| Cards enriched with official art | 1,349 (91%) |
| Database size | 20.3 MB (~$0.03/mo) |

Re-check any of these with `npm run db:verify`.

## Quick start

No credentials needed to see the data:

```bash
npm install
npm run snapshot        # -> data/riftbound-market-snapshot.json
```

To run the site against a real database:

```bash
cp .env.example .env    # fill in the two Neon URLs
npm run db:push         # create the tables
npm run ingest          # cards + today's prices
npm run dev             # http://localhost:3000/riftmarket
```

## How it works

Two free, keyless upstreams joined on a shared id:

- **[tcgcsv.com](https://tcgcsv.com)** — a public mirror of TCGplayer's API
  (category 89 = Riftbound). Products and daily prices. TCGplayer's own API is
  partner-gated, which is why this mirror is used.
- **[Riftcodex](https://api.riftcodex.com)** — Riot's official card art, artist
  credits, and canonical card ids.

`/prices` upstream is a **today-only snapshot**, so price *history* is something
this project accumulates: one row per `(product, printing, day)`, written daily
by a GitHub Actions job. `npm run backfill` can pull historical days from the
tcgcsv archive (back to 2024-02-08) to seed the chart data.

See [AGENTS.md](AGENTS.md) for the join logic, the sealed/single distinction, and
the deployment constraints.

## Development

```bash
npm test          # unit tests (node:test via tsx) — covers the join logic
npm run db:verify # row counts, storage, recent ingest runs
npm run neon:tune # apply the COST.md compute settings (dry-run by default)
```

Homepage data is edge-cached for an hour (`src/lib/cache.ts`). That's a **cost**
measure, not a performance one — an uncached page view wakes Neon for the
5-minute scale-to-zero window. See [COST.md](COST.md) before changing it.

## Stack

Next.js 16 (App Router, SSR) · Prisma 6 + Neon Postgres · Cloudflare Workers via
OpenNext · Tailwind 4.
