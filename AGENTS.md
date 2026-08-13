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

# Pricing — the point of the project

**The headline price is the median of the last 10 completed TCGplayer sales
(Near Mint), refreshed hourly.** Not tcgcsv's `marketPrice`, which is
TCGplayer's own smoothed algorithm over sales — a step further from the truth and
a day stale. `marketPrice` is kept as a *fallback* and for history.

## A price belongs to a VARIANT, not a card

**Never compute one price per product.** A price is scoped to a `(finish, grade)`
pair, stored in `ProductPrice`:

- **Finish** — Normal vs Foil. Measured across 360 products, foils traded up to
  **18×** their normal counterpart (Traveling Merchant: $0.20 normal, $3.65
  foil). A blended median described neither, and this was a real shipped bug.
- **Grade** — raw vs PSA 10 vs BGS 10 Black Label vs CGC Pristine 10 … The same
  printing is a different market in a slab. See `src/lib/grading.ts`.
- **Printing** — signature / overnumbered / alternate art. On TCGplayer these are
  already *separate products*, so they need no extra axis there; for eBay's free
  text, `parsePrinting()` recovers them.

⚠️ **Rare and above only exist as Foil.** Riftbound prints every Rare, Epic and
Showcase card foil, so TCGplayer lists them under `subTypeName = "Foil"` with **no
Normal row at all** (verified across OGN/SFD/UNL/VEN: zero Normal price rows for
those rarities, a full set of Foil ones). Only Common and Uncommon have both
finishes. So reading the Normal price of a Rare returns **null, not a cheaper
number** — a bug that silently zeroes out most of a set's value, and the reason
`getBoxEvPageData()` joins both finishes and picks per rarity.

⚠️ **Classify printings from the TCGplayer name, not the Riftcodex flags.** The
`isAlternateArt` / `isSignature` / `isOvernumbered` columns lag each new set by
weeks (same cause as the `tcgplayer_id` lag below) and are wrong in ways that
wreck an average: on 2026-08-13 *every* Signature card had `isOvernumbered = false`
despite being numbered `306*/298`, and Vendetta had 43 Showcase cards with no flags
set at all. The `"(Signature)"` / `"(Overnumbered)"` / `"(Alternate Art)"` suffix
TCGplayer writes into the product name partitions all four booster sets exactly,
with zero leftovers, and works the day a set is listed. `classifyPrinting()` in
`src/lib/box-ev.ts` is the one implementation — reuse it.

`Product.salePrice` is a denormalised convenience holding the **most-traded**
bucket only, named by `Product.salePriceVariant`. The UI must always show that
label — a bare number implies it covers every printing, which it does not.

`src/lib/sale-price.ts` owns the rules. All of them come from real observed data,
so don't "simplify" them without new evidence:

- **Median, not mean.** One Near Mint copy sold at $1,099 the same day three
  others went for $850. A mean reports a price nothing sold at.
- **Near Mint only** (plus `Unopened`, which is sealed product's equivalent).
  Lightly Played copies of the same card traded ~27% below Near Mint; blending
  conditions describes a card nobody can buy. Every sale is still *stored*
  regardless of condition — the filter only governs the headline number.
- **≥ 3 sales required** (`MIN_SAMPLE_SIZE`). With n=1 the median *is* that one
  sale: 18 products were priced off a single sale, one landing 5.8× above market.
- **≤ 30 days old** (`MAX_SALE_AGE_DAYS`). A Metal Irelia was reporting $1,300
  from one sale 2.5 months earlier as its current price.

When a product fails those guards it gets **no** sales price and the UI falls
back to `marketPrice`, labelled `market est.` — never presented as sales-derived.
Currently ~1,434/1,534 are sales-priced; the rest are mostly signature/prize/metal
cards that genuinely trade rarely. **Pricing those better is a known open problem
— eBay sold-listings are the intended answer. Don't attempt it with TCGplayer
data.**

## The 5-sale ceiling (why the poller is hourly)

TCGplayer returns only the **5 most recent sales** per product. `limit` and
`offset` are both accepted and both **ignored** — paging at offset 0/5/10/15
returns the identical rows. Depth is therefore *accumulated*: poll hourly, store
what's new, compute from our own history.

The consequence: **a card selling more than 5 times within one polling interval
loses the oldest of those sales permanently.** That is the reason the job runs
hourly rather than daily. Don't lengthen the interval.

Sale identity is a hash of `(productId, orderDate, price, shipping, quantity,
condition, variant)` — the feed carries no sale id, and `customListingId` is the
*listing*, which recurs. Shipping is in the key because two genuine sales were
seen at the same second with the same price and quantity, differing only there.

⚠️ **A non-browser `User-Agent` gets `403` from TCGplayer's WAF.** Unlike the
tcgcsv archive (any UA works), this endpoint wants a browser one. It *is* served
to GitHub runners — verified, unlike Riftcodex.

Run `npm run ingest:sales -- --reprice-only` to re-apply the pricing rules to
already-stored sales without re-polling.

# Deals tracker — comparing like with like

`/deals` lists active listings priced ≥20% under what a card actually sells for.
Everything about it is a like-for-like comparison; each filter exists because
skipping it produced a wrong answer in practice (`src/lib/deals.ts`):

⚠️ **`listingType: "custom"` is the single most important filter.** TCGplayer
lets sellers attach custom listings — their own title, description and photos —
to any product page, and those need not be the same item. On
"Spiritforged - Booster Display" (benchmark **$187**) a dozen custom listings sat
at **$35–95**, titled `CHINESE - Spiritforged Booster Box - SLIM` (24 packs × 5
cards) and `CHINESE … JUMBO` (12 packs × 14 cards): a different print run *and* a
different box configuration. They render as 75%-off "deals" and are nothing of
the sort. Filtering to `standard` removed 1,184 listings and dropped the board
from 200 entries to 66 real ones.

> **The `language` field cannot catch this.** All 7,021 listings collected
> reported `language: "English"`, Chinese boxes included. Do not reach for it —
> the discriminator is structural, and it also excludes bundles, re-boxed product
> and lots, not just foreign printings.

The rest:

- **Near Mint only**, as an allow-list rather than a "not Damaged" block-list.
  Every tier below NM is cheaper *because it is worse*; against an NM benchmark
  they all read as permanent bargains.
- **Benchmark matched on finish.** Normal against Normal, Foil against Foil —
  they diverge by up to 18×, so a cross-finish comparison invents huge fake
  discounts.
- **Shipping must not exceed the saving.** A penny common at 71% off "saves"
  $0.37 and costs $1.49 to post. This removes cheap-card noise without an
  arbitrary price floor.
- **≥75% off is flagged, not hidden** (`SUSPICIOUS_DISCOUNT`) and sorted into its
  own section. Credible and flagged deals are fetched as *separate queries* —
  sorting flagged last and truncating hid them entirely once there were enough
  real deals to fill the page.

Watch list: Epic/Showcase rarity, or worth over $1 — 633 of 1,534 products.
Polled hourly by `listings.yml` at :05, staggered off sales (:35) and the daily
price ingest (21:15) so the jobs never contend on the same Neon compute.

Listings are **replaced** each run, not accumulated — the opposite of `Sale`. A
listing that sold must vanish rather than linger as a phantom deal.

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
