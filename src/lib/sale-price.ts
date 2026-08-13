// Turning a list of sales into "the price of this card".

/** How many recent sales the headline price is computed over. */
export const PRICE_SAMPLE_SIZE = 10;

/**
 * Sales older than this don't count toward the current price.
 *
 * Without it, an illiquid card reports whatever it last sold for whenever that
 * was — observed live: a Metal Irelia showing $1,300 from a SINGLE sale on
 * 2026-05-29, presented as today's price two and a half months later. A price
 * that old isn't a price, it's a memory. Cards with no recent sales are better
 * served by falling back to TCGplayer's market price and saying so.
 */
export const MAX_SALE_AGE_DAYS = 30;

/**
 * Minimum qualifying sales before a sales-derived price is published.
 *
 * With a sample of one, the "median" is just that one sale, so a single
 * mispriced or bundled listing becomes the card's price — measured: 18 products
 * priced off one sale, and a Pre-Rift Event Kit sitting 5.8x above market. Three
 * is the smallest sample where a lone outlier can't win the median outright.
 */
export const MIN_SAMPLE_SIZE = 3;

/**
 * Conditions allowed into the headline price.
 *
 * Near Mint only for singles. Condition moves price enormously — a signature
 * card was observed selling Near Mint at $850–1099 while Lightly Played copies
 * of the same card went for $623 — so a blended number would describe no card
 * anyone can actually buy. Sealed product sells as "Unopened", which is its
 * equivalent of Near Mint.
 *
 * Every sale is still STORED regardless of condition; this only governs which
 * ones set the headline price.
 */
export const HEADLINE_CONDITIONS = new Set(["Near Mint", "Unopened"]);

export type PriceableSale = {
  purchasePrice: number;
  orderDate: Date | string;
  condition: string;
};

export type SalePriceResult = {
  price: number | null;
  low: number | null;
  high: number | null;
  sampleSize: number;
  lastSaleAt: Date | null;
  /** Why there's no price, when there isn't one — surfaced in the UI. */
  reason: "ok" | "no-sales" | "too-old" | "too-few";
};

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Headline price from recent sales.
 *
 * MEDIAN, not mean. Real sales include genuine outliers — one Near Mint copy
 * went for $1099 while three others sold at $850 the same day — and a mean would
 * let a single mispriced or premium sale drag the number. The median of ten
 * shrugs it off, which is the entire point of using sales over a smoothed feed.
 *
 * Sales are NOT weighted by quantity: `purchasePrice` is already per-unit, and a
 * bulk buyer taking 24 packs at a discount shouldn't outvote 9 single sales when
 * reporting what one copy costs.
 */
export function computeSalePrice(
  sales: PriceableSale[],
  opts: { sampleSize?: number; maxAgeDays?: number; minSample?: number; now?: Date } = {},
): SalePriceResult {
  const sampleSize = opts.sampleSize ?? PRICE_SAMPLE_SIZE;
  const maxAgeDays = opts.maxAgeDays ?? MAX_SALE_AGE_DAYS;
  const minSample = opts.minSample ?? MIN_SAMPLE_SIZE;
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - maxAgeDays * 86_400_000;

  const none = (reason: SalePriceResult["reason"], lastSaleAt: Date | null = null) => ({
    price: null,
    low: null,
    high: null,
    sampleSize: 0,
    lastSaleAt,
    reason,
  });

  const usable = sales
    .filter((s) => HEADLINE_CONDITIONS.has(s.condition))
    .filter((s) => Number.isFinite(s.purchasePrice) && s.purchasePrice > 0)
    .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime());

  if (usable.length === 0) return none("no-sales");

  const newest = new Date(usable[0].orderDate);
  const recent = usable
    .filter((s) => new Date(s.orderDate).getTime() >= cutoff)
    .slice(0, sampleSize);

  // Everything on record predates the window — report the staleness rather than
  // quietly publishing a months-old figure as today's price.
  if (recent.length === 0) return none("too-old", newest);
  if (recent.length < minSample) return none("too-few", newest);

  const prices = recent.map((s) => s.purchasePrice).sort((a, b) => a - b);
  return {
    price: Number(median(prices).toFixed(2)),
    low: prices[0],
    high: prices[prices.length - 1],
    sampleSize: recent.length,
    lastSaleAt: new Date(recent[0].orderDate),
    reason: "ok",
  };
}
