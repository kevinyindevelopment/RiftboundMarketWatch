# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

> 💸 **Read [COST.md](COST.md) before changing anything that touches the
> database.** This project runs on a paid Neon plan and must stay near-free.
> Compute (query frequency), not storage, is the cost driver.

# What this is

**Riftbound Market Watch** tracks TCGplayer prices for every released Riftbound
card. Sibling project to **RiftboundElo** (the ratings site) and deployed the
same way: **Cloudflare Workers** via the OpenNext adapter, **Neon Postgres**,
served under a sub-path of **kevin-yin.com**.

- This app: **`/riftmarket`**
- Ratings app: `/riftelo` (separate repo/Worker — don't touch its route)
- The domain root is reserved for other content.

# Data sources — the important part

Two upstreams, joined into one table. Neither needs an API key.

### 1. TCGplayer products + prices, via **tcgcsv.com** (`src/lib/tcgcsv.ts`)

TCGplayer's own API is partner-gated and closed to new applicants. tcgcsv.com is
a public mirror of it, refreshed **daily ~20:00 UTC**.

- Riftbound is **categoryId 89**. The tree is category → group (set) → product,
  with prices keyed by `productId`.
- A product is a **single** or a **sealed** item. TCGplayer only fills
  `extendedData` (rarity/number/card text) for singles, so an **empty
  `extendedData` is the sealed test** — that's what `isSealed` keys off.
- ⚠️ **`/prices` is TODAY ONLY.** It carries no date and no history. History is
  built by storing one row per `(productId, subTypeName, date)` on each run.
- ⚠️ **A product can be both Normal and Foil at different prices.** Never key
  price data on `productId` alone — it is not unique.

### 2. Card metadata, via **Riftcodex** (`src/lib/riftcodex.ts`)

Gives Riot's official art, artist credit, and the canonical `riftbound_id` —
none of which TCGplayer carries. ~1450 cards, 100/page.

**The join is two-stage, and the fallback matters:**

1. Primary: Riftcodex's own `tcgplayer_id`.
2. Fallback: rebuild `riftbound_id` as
   `` `${setCode}-${tcgplayerNumber.replace("/", "-")}`.toLowerCase() ``.

Riftcodex assigns `tcgplayer_id` **by hand**, so it lags each new set by weeks —
when this was written, *all 227* Vendetta cards were unlinked. The derived key
closes most of that gap. It was verified against all 1223 already-linked cards:
**1223 agreements, 0 disagreements**. Variant markers (`084a`, `229*`) are
preserved by the rule, which is exactly why it beats name-matching (names are
ambiguous across alternate arts — measured 16 ambiguous vs 0 for this key).

tcgcsv's group `abbreviation` **is** the Riftcodex set code (`VEN`, `OGN`), so no
hardcoded group→set table is needed. Promo groups (`PR`/`OPP`/`JDG`) have no
Riftcodex counterpart and correctly fall through unjoined.

> ⚠️ **Riftcodex 403s from datacenter IPs.** It answers fine from a home
> connection but returns `403 Forbidden` on GitHub Actions runners — this took
> down the first backfill run. Note this is a *different* failure from the tcgcsv
> archive 401 above: a descriptive `User-Agent` was already being sent when
> Riftcodex 403'd, so it is presumed IP-based, not header-based. Don't burn time
> re-testing headers. So **Riftcodex is treated as optional**:
> `collectAll()` catches the failure, sets `riftcodexAvailable: false`, and
> carries on with TCGplayer data alone.
>
> The subtle part is in `scripts/ingest.ts`: when that flag is false, the
> enrichment fields are **omitted from the UPDATE** rather than written as null.
> Writing them would erase art and artist credits already in the database on
> every cloud run. `IngestRun.note` records when a run was degraded, and
> `npm run db:verify` prints it.
>
> Practical consequence: **enrichment must be refreshed from a non-datacenter
> IP** (i.e. locally, via `npm run ingest`). The daily cloud job keeps prices
> current; it cannot pick up art for newly-released cards.

Current coverage: **1349 / 1479 singles joined (91%)**. The remainder are OP
promos and brand-new signatures that simply aren't in Riftcodex yet — they still
have full TCGplayer metadata and prices, just no official art.

# Scripts

| Command | Needs a DB? | What it does |
| --- | --- | --- |
| `npm run snapshot` | **No** | Dumps the whole dataset to `data/*.json`. The zero-credential path; use it to sanity-check upstream. |
| `npm run ingest` | Yes | Same fetch, written to Neon. **Idempotent** — re-running on the same UTC day overwrites that day rather than duplicating. |
| `npm run backfill -- --from YYYY-MM-DD` | Yes | Historical prices from the tcgcsv archive (back to 2024-02-08). **Requires `7z` on PATH** (PPMd; Node's zlib can't read it). Run it via the `backfill.yml` workflow, where 7z is preinstalled. |

> ⚠️ **The tcgcsv archive host 401s a request with NO `User-Agent`.** Node's
> `fetch` sends none by default, so `fetch(url)` gets `401 Unauthorized` while the
> same URL downloads fine from PowerShell or curl. That looks exactly like "this
> endpoint requires auth" and cost a debugging cycle chasing an imagined IP block.
> **Any** non-empty UA is accepted. `scripts/backfill-prices.ts` sets one — don't
> remove it.

`snapshot` and `ingest` run the *same* `collectAll()` from `src/lib/collect.ts`,
which has no DB dependency — so the offline dump and the real ingest can't drift.

# Automatic updates

**GitHub Actions**, `.github/workflows/update.yml` — daily at **21:15 UTC**, just
after tcgcsv's ~20:00 refresh. Polling more often is pointless: upstream is a
once-daily snapshot with no intraday detail.

Secrets needed (repo → Settings → Secrets → Actions): `DATABASE_URL`,
`DIRECT_DATABASE_URL`.

⚠️ GitHub auto-disables scheduled workflows after **60 days with no repo
commits** — an occasional push keeps it alive.

# Deployment

Same constraints as RiftboundElo:

- **Deploy from WSL, not native Windows** — OpenNext's bundler breaks on Windows
  paths. There is no git-push deploy; changes go from the working tree to
  Cloudflare via `npm run cf:deploy`.
- **Don't casually change the Prisma/DB wiring.** `engineType = "client"` +
  always-adapter (`PrismaNeon`) + `.prisma/client` in `serverExternalPackages` +
  `neonConfig.poolQueryViaFetch` are what make Prisma work on Workers. Reverting
  any one of them breaks the live site (engine-not-found / wasm-fs-read /
  random 500s).
- `next` must satisfy `@opennextjs/cloudflare`'s peer range (currently
  `>=16.2.11`). Pinning an older 16.2.x fails `npm install` outright.
- Data changes need **no redeploy** — the scripts write straight to Neon and the
  SSR site reads it on the next request.
- **`.env` is NOT bundled into the Worker.** The deployed app reads
  `DATABASE_URL` (the *pooled* URL) from a Cloudflare secret, set once with
  `npx wrangler secret put DATABASE_URL`. A local `.env` alone gets you a
  deployed site that renders the "No database yet" fallback. `wrangler secret
  list` shows what's set. The direct URL is *not* needed at runtime — only the
  CLI scripts use it.

Live URLs:
- <https://kevin-yin.com/riftmarket> (production route)
- <https://riftmarket.doombornegame.workers.dev/riftmarket> (smoke-test target)
