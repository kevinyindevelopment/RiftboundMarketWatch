// Edge-cache the *results* of database queries.
//
// Why this and not Next.js ISR: full ISR on Cloudflare needs an incremental
// cache binding (KV/R2) PLUS a Durable Object queue for time-based revalidation
// — real infrastructure, and a DO namespace, to cache a page that changes once a
// day. See https://opennext.js.org/cloudflare/caching.
//
// The thing that actually costs money here is Neon compute, not Worker CPU (see
// COST.md): every uncached page view wakes the database and holds it for the
// 5-minute scale-to-zero window. Caching the query *results* removes the Neon
// hit, which is the expensive part, while still re-rendering React per request —
// which is cheap and already paid for.
//
// Storage is the Workers Cache API. Note it is per-colo, not global: a visitor
// in a new region misses once and repopulates. That's fine — it turns "one DB
// wake per visitor" into "one per region per TTL", which is the whole point.

import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Minimal shape of the KV binding we use — avoids pulling in workers-types. */
type KVNamespace = {
  get(key: string, type: "text"): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
};

/**
 * The KV binding declared in wrangler.jsonc, or null outside Workers.
 *
 * `getCloudflareContext()` throws when there is no Worker context (plain `tsx`
 * scripts, `next dev` on Node), which is expected — the memory tier covers those.
 */
function kv(): KVNamespace | null {
  try {
    const env = getCloudflareContext().env as unknown as {
      RIFTMARKET_CACHE?: KVNamespace;
    };
    return env?.RIFTMARKET_CACHE ?? null;
  } catch {
    return null;
  }
}

/**
 * Tier 1: per-isolate memory.
 *
 * Not just a dev fallback — this is the primary tier in production too. A
 * Workers isolate serves many requests before being recycled, so this absorbs
 * most traffic with no I/O at all. The Cache API below is per-colo and
 * evictable, so relying on it alone gives inconsistent hit rates (measured:
 * request latency alternating between ~0.24s and ~1.9s).
 */
const memory = new Map<string, { expires: number; value: unknown }>();

/** Which tier served the most recent `cached()` call — for /api/cache-status. */
export type CacheTier = "memory" | "kv" | "origin";
let lastTier: CacheTier = "origin";
export function lastCacheTier(): CacheTier {
  return lastTier;
}

/**
 * Run `fn`, caching its JSON-serialisable result for `ttlSeconds`.
 *
 * IMPORTANT: the value round-trips through JSON, so `Date` objects come back as
 * strings. Cache only JSON-safe shapes — see `getHomeData()`, which formats
 * dates to ISO strings before they reach this function.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();

  // Tier 1: memory. Free, and serves most requests within an isolate's life.
  const local = memory.get(key);
  if (local && local.expires > now) {
    lastTier = "memory";
    return local.value as T;
  }

  // Tier 2: KV. Survives isolate recycling and cold starts, which is the case
  // that actually costs money — sparse traffic, where every visitor would
  // otherwise land on a fresh isolate and wake the database.
  const store = kv();
  if (store) {
    try {
      const raw = await store.get(key, "text");
      if (raw !== null) {
        const value = JSON.parse(raw) as T;
        // Promote into memory so the rest of this isolate's requests are free.
        memory.set(key, { expires: now + ttlSeconds * 1000, value });
        lastTier = "kv";
        return value;
      }
    } catch {
      // Never let a cache problem take the page down — fall through to the DB.
    }
  }

  lastTier = "origin";
  const value = await fn();
  memory.set(key, { expires: now + ttlSeconds * 1000, value });

  if (store) {
    try {
      // expirationTtl is enforced by KV itself, so stale entries can't linger.
      // KV's floor is 60s; anything shorter is rejected.
      await store.put(key, JSON.stringify(value), {
        expirationTtl: Math.max(60, ttlSeconds),
      });
    } catch {
      // Best-effort; the memory tier still holds the value for this isolate.
    }
  }

  return value;
}

/**
 * How long homepage data may be stale.
 *
 * Upstream refreshes once daily (~20:00 UTC) and the ingest runs at 21:15 UTC,
 * so anything under a day is defensible; an hour keeps it feeling live while
 * cutting DB wakes by orders of magnitude under real traffic.
 */
export const HOME_TTL_SECONDS = 3600;

/**
 * Deals go stale faster than prices — a listing can sell at any moment — but
 * the underlying listing data only refreshes hourly, so there's nothing to gain
 * from a shorter window than this and plenty of Neon compute to lose.
 */
export const DEALS_TTL_SECONDS = 900;
