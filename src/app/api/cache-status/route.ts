// Operational check: is the read-path cache actually working?
//
// Caching is a COST control here (see COST.md), and a silently-broken cache
// looks exactly like a working one from the outside — the page renders fine
// either way, it just wakes Neon on every hit. This endpoint makes the tier
// observable instead of inferred from response times.
//
//   GET /riftmarket/api/cache-status

import { getHomeData } from "@/lib/queries";
import { lastCacheTier } from "@/lib/cache";

export const dynamic = "force-dynamic";

export async function GET() {
  const t0 = Date.now();
  await getHomeData();
  const first = { tier: lastCacheTier(), ms: Date.now() - t0 };

  // The second call must be served from memory. If it reports "origin", the
  // cache is not retaining anything and every visitor is hitting the database.
  const t1 = Date.now();
  await getHomeData();
  const second = { tier: lastCacheTier(), ms: Date.now() - t1 };

  return Response.json(
    {
      first,
      second,
      healthy: second.tier !== "origin",
      note:
        second.tier === "origin"
          ? "Cache is NOT retaining — every request will wake Neon."
          : "Cache is retaining; repeat requests avoid the database.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
