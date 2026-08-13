// TCGplayer product + price data, via tcgcsv.com.
//
// Why tcgcsv and not TCGplayer directly: TCGplayer's own API is closed to new
// applicants (partner-gated). tcgcsv.com is a public mirror of that API's
// category/group/product/price tree, refreshed daily ~20:00 UTC, no auth, no key.
//
// The hierarchy is Category > Group > Product, with prices keyed by productId:
//   category 89        = "Riftbound League of Legends Trading Card Game"
//   group    24344     = "Origins" (a set / sealed line)
//   product  705996    = "Ahri - Inquisitive" (a single) or a booster box
//
// IMPORTANT: `/prices` is a SNAPSHOT of today only — it carries no date and no
// history. Price history is built by storing one row per (product, subtype, day)
// on each run; see scripts/ingest.ts. Historical days can be backfilled from
// tcgcsv's archive (prices-YYYY-MM-DD.ppmd.7z, from 2024-02-08 onward).

/** tcgcsv's category id for Riftbound. Stable; verified live. */
export const RIFTBOUND_CATEGORY_ID = 89;

const BASE = process.env.TCGCSV_BASE ?? "https://tcgcsv.com/tcgplayer";

/** tcgcsv wraps every payload in {success, errors, results}. */
type TcgcsvEnvelope<T> = { success: boolean; errors: string[]; results: T[] };

export type TcgcsvGroup = {
  groupId: number;
  name: string;
  abbreviation: string | null;
  isSupplemental: boolean;
  publishedOn: string;
  modifiedOn: string;
  categoryId: number;
};

/** One key/value pair of TCGplayer's per-card metadata (rarity, number, ...). */
export type TcgcsvExtendedField = {
  name: string;
  displayName: string;
  value: string;
};

export type TcgcsvProduct = {
  productId: number;
  name: string;
  cleanName: string;
  imageUrl: string;
  categoryId: number;
  groupId: number;
  url: string;
  modifiedOn: string;
  imageCount: number;
  presaleInfo: {
    isPresale: boolean;
    releasedOn: string | null;
    note: string | null;
  };
  // Populated for singles (rarity/number/card text); EMPTY for sealed products,
  // which is exactly how we tell the two apart. See `isSealed` in normalize.ts.
  extendedData: TcgcsvExtendedField[];
};

export type TcgcsvPrice = {
  productId: number;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  directLowPrice: number | null;
  // "Normal" | "Foil" — a product can have BOTH, so a price row is only unique
  // per (productId, subTypeName). Never key price data on productId alone.
  subTypeName: string;
};

async function getJson<T>(path: string): Promise<T[]> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "RiftboundMarketWatch" },
  });
  if (!res.ok) {
    throw new Error(`tcgcsv ${res.status} ${res.statusText} for ${url}`);
  }
  const body = (await res.json()) as TcgcsvEnvelope<T>;
  if (!body.success) {
    throw new Error(`tcgcsv reported failure for ${url}: ${body.errors?.join("; ")}`);
  }
  return body.results ?? [];
}

/** Every Riftbound set/group tracked by TCGplayer. */
export function fetchGroups(): Promise<TcgcsvGroup[]> {
  return getJson<TcgcsvGroup>(`/${RIFTBOUND_CATEGORY_ID}/groups`);
}

/** Every product (singles AND sealed) in one group. */
export function fetchProducts(groupId: number): Promise<TcgcsvProduct[]> {
  return getJson<TcgcsvProduct>(`/${RIFTBOUND_CATEGORY_ID}/${groupId}/products`);
}

/** Today's price snapshot for one group. */
export function fetchPrices(groupId: number): Promise<TcgcsvPrice[]> {
  return getJson<TcgcsvPrice>(`/${RIFTBOUND_CATEGORY_ID}/${groupId}/prices`);
}

/** Look up one extendedData field by its TCGplayer `name`. */
export function extField(
  product: TcgcsvProduct,
  name: string,
): string | undefined {
  return product.extendedData.find((f) => f.name === name)?.value;
}
