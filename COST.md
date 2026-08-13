# Cost discipline — read before changing anything that touches the database

**Standing rule: this project must stay near-free to run.** Every change that adds
a query path, a scheduled job, or a stored row is a cost decision. If a change
would make the database busier or bigger, justify it here or don't make it.

## The plan we're on

Neon **Launch**:

| | |
| --- | --- |
| Autoscale | up to 16 CU |
| Scale to zero | after 5 min idle |
| Storage | **$0.35 / GB-month** |
| Instant restore (PITR) | **$0.20 / GB-month** |
| Included | 10 branches, 500 GB egress, 100 projects |

## Where the money actually goes

**Compute is the cost. Storage is rounding error.** Do not optimize the wrong one.

Measured on 2026-08-13 with 91 days of history loaded (`npm run db:verify`):

```
PriceSnapshot    18 MB      154,820 rows
Product          1712 kB      1,534 rows
IngestRun          80 kB
CardSet            48 kB
TOTAL            20.3 MB
~228 KB/day  →  ~81 MB/yr  ≈  $0.03/mo storage at year end
```

`Product` barely grows (a new set adds ~300 rows a few times a year).
`PriceSnapshot` grows ~1,700–2,000 rows every day, forever.

`Sale` is the newer growth source: ~7,300 rows landed on the first full sweep,
and hourly polling adds only genuinely *new* sales after that (dedup by natural
key), so the steady-state rate follows real market activity rather than the poll
frequency. Re-check with `npm run db:verify`, which prints per-table sizes.

So **a full year of price history costs about three cents a month**. Storage is
not worth contorting the schema over — do not add delta-encoding, pruning, or
archival tiers to "save space" unless the numbers above change by orders of
magnitude. Re-run `npm run db:verify` to check rather than guessing.

Compute is different. Neon bills CU-hours, and **scale-to-zero only helps if
nothing is talking to the database**. A single request after an idle period spins
compute back up and holds it for at least the 5-minute idle window. So:

> **The dominant cost driver is how often the site queries Neon, NOT how much
> data we store.**

Sporadic traffic is the worst case: 20 visits/day spread evenly could pin compute
for ~100 min/day, while 20 visits in one burst costs ~5 min. This is why caching
matters far more than row counts.

## Rules

1. **Never put an uncached DB query on a hot path.** Prices change **once a day**
   (tcgcsv refreshes ~20:00 UTC). There is no reason for two visitors in the same
   hour to cause two sets of queries. Cache aggressively — the data is stale by
   design.
2. **Two scheduled write jobs, and their intervals are deliberate.**
   - `update.yml` (daily, 21:15 UTC) — tcgcsv products + prices. Do **not**
     shorten it: upstream is a once-daily snapshot, so a more frequent job would
     rewrite identical numbers and wake compute for nothing.
   - `sales.yml` (hourly, :35) — TCGplayer sales. Hourly is **required**, not a
     preference: only the 5 most recent sales are exposed, so a longer gap
     permanently loses sales for any card that trades more than 5 times in it.
     Measured cost: ~2 min/run wall clock (61s of it polling 1,534 products),
     ≈ 1,440 GitHub Actions minutes/month — inside the 2,000-minute free tier for
     private repos, but with little headroom. Adding a *third* hourly job, or
     slowing this one down, would push it into paid overage.
3. **Batch writes; never loop single queries over the network.** The ingest sends
   ~16 concurrent upserts and bulk `createMany` for prices. A naive per-row
   sequential loop would hold compute open far longer for the same work.
4. **Keep instant-restore retention short.** Every day of PITR window is billed at
   $0.20/GB-month. **This entire database is reproducible from upstream** —
   `npm run ingest` rebuilds products and today's prices from scratch. The only
   truly irreplaceable data is accumulated price history, and even that is
   re-derivable from the tcgcsv archive. Set retention to the **minimum** (24 h);
   do not pay to protect regenerable data.
5. **No always-on connections.** The app uses `poolQueryViaFetch` (stateless HTTP)
   precisely so it holds nothing open. Never introduce a long-lived pool, a
   `LISTEN`, or a polling healthcheck against Neon.
6. **Don't create branches casually.** Branches carry their own storage. Delete
   any experiment branch when done.
7. **Verify with `npm run db:verify`, not by browsing in Studio.** `prisma studio`
   holds a connection open and keeps compute warm.

## Compute settings — managed by `npm run neon:tune`

**Don't set these by hand.** `scripts/neon-tune.ts` holds the targets and applies
them through the Neon API. Dry-run by default; `-- --apply` writes; re-running is
idempotent. Applied and verified 2026-08-13:

| Setting | Value | Why |
| --- | --- | --- |
| `autoscaling_limit_min_cu` | **0.25** | Billed for every minute the DB is awake — **the number that matters**. |
| `autoscaling_limit_max_cu` | **2** | A 20 MB DB on indexed queries never needs more; a low ceiling caps a pathological query. Was 8. |
| `suspend_timeout_seconds` | **300** | Scale to zero after 5 min. Set explicitly so it can't drift with the account default. |
| `history_retention_seconds` | **86400** | 1 day. The DB is reproducible from upstream (rule 4). |

Two API quirks worth knowing:

- `suspend_timeout_seconds: 0` does **not** mean "never suspend" — it means *use
  the account default*. `-1` is never. A `0` here is not a bug.
- `GET /projects` returns `400 org_id is required` on org-scoped accounts (now the
  default). The script enumerates `/users/me/organizations` and lists per-org.

> ⚠️ **Do not infer the CU range from `max_connections`.** An earlier pass did
> exactly that — read `max_connections = 901`, matched it against Neon's published
> table (2 CU → 839, 8 CU → 3357), and concluded the compute was capped at ~2 CU.
> **That was wrong**: the API showed the endpoint really was 0.25↔8. The published
> mapping does not reliably reflect an autoscaling endpoint's configured ceiling.
> `npm run neon:tune` reads the actual config — use it instead of guessing from SQL.

Still worth confirming in the console (not exposed on the endpoint API):

- [ ] The **Compute defaults** panel seeds only newly created computes, so if a
      compute is ever recreated, re-run `npm run neon:tune` rather than trusting
      it to inherit the right values.

## Read-path caching — done, and why it looks the way it does

Homepage data is cached for **1 hour** in two tiers (`src/lib/cache.ts`, entry
point `getHomeData()`):

1. **Per-isolate memory** — free, absorbs repeat requests within an isolate.
2. **Workers KV** — survives isolate recycling and cold starts.

Without this, every visitor ran five queries and woke Neon for the full 5-minute
scale-to-zero window. With it the database is read **at most once an hour**.

**Why not Next.js ISR.** Time-based ISR on Cloudflare needs an incremental cache
binding *plus* a Durable Object queue, and a tag cache for on-demand
revalidation — real infrastructure to cache one page that changes once a day.
Caching the query *results* targets the thing that costs money (Neon compute) and
leaves the cheap thing (Worker CPU re-rendering React) alone.

**Why KV and not the Workers Cache API.** The Cache API was tried first — it needs
no binding — and *measured unreliable*. Via `/api/cache-status`:

```
Cache API:  call 1 → origin (1850ms) | call 2 → edge (40ms) | call 3 → origin (926ms)
KV:         call 1 → origin (2083ms) | call 2 → kv   (12ms) | call 3 → kv     (72ms)
```

It evicted between requests and fell back to the database roughly half the time.
That fails precisely where it matters: **sparse traffic**, where each visitor
lands on a fresh isolate. KV retains. Cost is ~24 writes/day and a handful of
reads — far inside the free tier.

Trade-offs to know before changing it:
- Cached values **round-trip through JSON**, so `Date` becomes `string`.
  `getHomeData()` normalises dates to ISO strings *before* caching so the hit and
  miss paths return identical shapes. Keep any new cached payload JSON-safe.
- Bump the cache key (`home:v1`) when the payload shape changes, or entries
  written by old code will deserialise into the new shape.
- KV's minimum `expirationTtl` is 60s; shorter values are rejected.

**Check it's still working:** `GET /riftmarket/api/cache-status` reports the tier
that served each of two back-to-back calls. If the second says `origin`, the
cache is retaining nothing and every visitor is waking Neon.
