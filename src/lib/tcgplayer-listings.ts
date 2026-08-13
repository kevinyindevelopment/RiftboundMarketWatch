// TCGplayer active listings — the "asks" side of the market.
//
// Sales tell us what a card is WORTH; listings tell us what's available to buy
// right now. The deals tracker is the difference between the two.
//
// Same host family and the same browser-User-Agent requirement as the sales
// feed, but a different service: `mp-search-api`, not `mpapi`. (`mpapi`
// 404s for listings — that's a wrong-host error, not a missing product.)

const BASE =
  process.env.TCGPLAYER_SEARCH_BASE ?? "https://mp-search-api.tcgplayer.com/v1";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export type TcgListing = {
  listingId: number;
  productId: number;
  /** "Normal" | "Foil" — must match the finish a price is scoped to. */
  printing: string;
  condition: string;
  language: string;
  price: number;
  shippingPrice: number;
  quantity: number;
  sellerName: string;
  sellerRating: number | null;
  sellerSales: string | null;
  directSeller: boolean;
  directInventory: number | null;
  /**
   * "standard" | "custom".
   *
   * THE most important field on this object. A `custom` listing is seller-
   * defined and is NOT guaranteed to be the catalogue product — sellers use it
   * to list physically different items under the same product page. Observed on
   * "Spiritforged - Booster Display" ($187 benchmark): a dozen custom listings
   * at $35–95 titled "CHINESE … SLIM" (24 packs × 5 cards) and "CHINESE …
   * JUMBO" (12 packs × 14 cards). Different print run, different contents,
   * different market.
   */
  listingType: string;
  /** Seller-authored title/description, present only on custom listings. */
  customData?: {
    title?: string;
    description?: string;
    images?: string[];
  } | null;
};

type ListingsResponse = {
  results?: {
    totalResults: number;
    results: TcgListing[];
  }[];
};

/**
 * Cheapest active listings for a product, price+shipping ascending.
 *
 * We only ever want the cheap end — a deal lives there by definition — so this
 * asks for a small page rather than paging the whole inventory (a single common
 * had 880 live listings).
 */
export async function fetchListings(
  productId: number,
  opts: { size?: number; retries?: number; signal?: AbortSignal } = {},
): Promise<TcgListing[]> {
  const size = opts.size ?? 25;
  const retries = opts.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const res = await fetch(`${BASE}/product/${productId}/listings`, {
        method: "POST",
        headers: {
          "user-agent": BROWSER_UA,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          // sellerStatus Live excludes vacationing/suspended sellers, whose
          // listings can't actually be bought — they'd be phantom "deals".
          filters: { term: { sellerStatus: "Live", channelId: 0 }, range: {}, exclude: {} },
          from: 0,
          size,
          sort: { field: "price+shipping", order: "asc" },
          context: { shippingCountry: "US" },
          aggregations: [],
        }),
        signal: opts.signal,
      });

      if (res.status === 404) return [];
      if (res.ok) {
        const json = (await res.json()) as ListingsResponse;
        return json.results?.[0]?.results ?? [];
      }
      if (res.status < 500) {
        throw new Error(`tcgplayer listings ${res.status} for product ${productId}`);
      }
      lastError = new Error(`tcgplayer listings ${res.status} for product ${productId}`);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err;
      if (err instanceof Error && /listings 4\d\d/.test(err.message)) throw err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`tcgplayer listings failed for product ${productId}`);
}
