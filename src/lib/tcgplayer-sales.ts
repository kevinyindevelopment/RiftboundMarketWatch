// TCGplayer "Latest Sales" — the feed behind the sales list on a product page.
//
// This is the price signal of record for this project. tcgcsv's `marketPrice` is
// TCGplayer's own smoothed algorithm over recent sales; this is the raw sales, so
// a price can be computed transparently and reacts immediately.
//
// TWO UPSTREAM QUIRKS, both verified — don't re-derive them:
//
//  1. A non-browser `User-Agent` gets a bare `403 Forbidden` from the WAF. Unlike
//     the tcgcsv archive (which accepts any UA), this endpoint specifically wants
//     a browser one. Measured: project UA -> 403, browser UA -> 200.
//
//  2. **Only the 5 most recent sales are available.** `limit` and `offset` are
//     both accepted and both ignored — paging with offset 0/5/10/15 returns the
//     identical 5 rows. Depth is built by polling over time and storing what's
//     new (see the `Sale` model), NOT by asking for more.
//
// `conditions: [1]` DOES filter server-side to Near Mint, which matters because
// an unfiltered response mixes conditions with very different prices (a signature
// card showed Near Mint at $850–1099 alongside Lightly Played at $623).

const BASE =
  process.env.TCGPLAYER_MPAPI_BASE ?? "https://mpapi.tcgplayer.com/v2";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export type TcgSale = {
  condition: string;
  variant: string | null;
  language: string | null;
  quantity: number;
  title: string | null;
  listingType: string | null;
  customListingId: string | null;
  purchasePrice: number;
  shippingPrice: number;
  orderDate: string;
};

type SalesResponse = {
  previousPage: string;
  nextPage: string;
  resultCount: number;
  totalResults: number;
  data: TcgSale[];
};

/**
 * The 5 most recent sales for a product.
 *
 * Returns `null` (rather than throwing) when the product simply has no sales
 * data, so a sweep over 1,500 products isn't derailed by individual gaps.
 * Genuine transport/HTTP failures DO throw — the caller counts them, because a
 * sweep that silently returns nothing for everything must not look successful.
 */
export async function fetchLatestSales(
  productId: number,
  opts: { nearMintOnly?: boolean; signal?: AbortSignal; retries?: number } = {},
): Promise<TcgSale[] | null> {
  const body: Record<string, unknown> = {
    limit: 25, // ignored upstream; sent to match what the site sends
    listingType: "All",
    offset: 0,
  };
  // Server-side condition filter — cheaper and more reliable than fetching a
  // mixed list and discarding most of it, given only 5 rows come back at all.
  if (opts.nearMintOnly) body.conditions = [1];

  // Transient 5xx (mostly 504) show up at a low but steady rate across a sweep
  // of ~1,500 products — a couple per 40 in practice. Without a retry those
  // products silently miss an hour of sales, which is exactly the data this
  // whole job exists to capture.
  const retries = opts.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Backoff, jittered so a batch of six retries doesn't resend in lockstep.
      const wait = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await fetch(`${BASE}/product/${productId}/latestsales`, {
        method: "POST",
        headers: {
          "user-agent": BROWSER_UA,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (res.status === 404) return null;
      if (res.ok) {
        const json = (await res.json()) as SalesResponse;
        return json.data ?? [];
      }
      // 4xx other than 404 won't fix themselves — a 403 means the UA gate
      // changed, and retrying just multiplies the damage. Fail fast.
      if (res.status < 500) {
        throw new Error(`tcgplayer sales ${res.status} for product ${productId}`);
      }
      lastError = new Error(`tcgplayer sales ${res.status} for product ${productId}`);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err;
      // A non-5xx HTTP error thrown above must not be retried.
      if (err instanceof Error && /sales 4\d\d/.test(err.message)) throw err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`tcgplayer sales failed for product ${productId}`);
}

/**
 * Stable identity for a sale.
 *
 * The feed carries no sale id — `customListingId` identifies the *listing* and
 * recurs across sales — so identity is the natural tuple. Shipping is part of it
 * on purpose: two genuine sales were observed at the same second, same price and
 * quantity, differing only in shipping. Excluding it would collapse them into one.
 *
 * FNV-1a rather than a crypto hash: this runs ~1,500×/hour and only needs to be
 * deterministic and collision-resistant enough for a natural key, and it avoids
 * a node:crypto import in a module the Worker also loads.
 */
export function saleId(productId: number, sale: TcgSale): string {
  const key = [
    productId,
    sale.orderDate,
    sale.purchasePrice,
    sale.shippingPrice,
    sale.quantity,
    sale.condition,
    sale.variant ?? "",
  ].join("|");

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
