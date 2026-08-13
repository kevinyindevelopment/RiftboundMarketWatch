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
`PriceSnapshot` is the only real growth: ~1,700–2,000 rows every day, forever.

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
2. **One scheduled write job, once a day.** `update.yml` runs at 21:15 UTC. Do
   **not** shorten that interval "for freshness" — upstream is a once-daily
   snapshot, so a more frequent job would rewrite identical numbers and wake
   compute for nothing. (Contrast RiftboundElo, which polls every 3h because
   tournament results genuinely land throughout the day.)
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

## Dashboard settings to confirm (not settable from code)

- [ ] **Autoscale minimum → 0.25 CU.** The max (16 CU) only matters under load; the
      *minimum* is what you pay whenever the DB is awake. This dataset is tiny and
      never needs more than the floor.
- [ ] **Scale-to-zero → 5 min** (the plan minimum) — confirm it's actually on.
- [ ] **Instant-restore retention → 24 h** (see rule 4). This is likely the single
      biggest easy saving after compute.

## Biggest outstanding lever

`src/app/page.tsx` is currently `export const dynamic = "force-dynamic"`, so
**every page view runs ~4 queries against Neon.** That's the right default for
correctness but the wrong one for cost, given the data changes once a day.

The fix is ISR (or an edge cache) with a ~1 h revalidate window, which on
Cloudflare requires wiring an incremental cache into `open-next.config.ts` (R2 or
KV) plus the matching binding in `wrangler.jsonc` — see
<https://opennext.js.org/cloudflare/caching>. Until that's done, **treat public
traffic as the main cost risk**, not the data.
