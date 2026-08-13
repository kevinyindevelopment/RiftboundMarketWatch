// Turning a list of sales into "the price of this card".

/** How many recent sales the headline price is computed over. */
export const PRICE_SAMPLE_SIZE = 10;

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
  sampleSize: number = PRICE_SAMPLE_SIZE,
): SalePriceResult {
  const eligible = sales
    .filter((s) => HEADLINE_CONDITIONS.has(s.condition))
    .filter((s) => Number.isFinite(s.purchasePrice) && s.purchasePrice > 0)
    .sort((a, b) => new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime())
    .slice(0, sampleSize);

  if (eligible.length === 0) {
    return { price: null, low: null, high: null, sampleSize: 0, lastSaleAt: null };
  }

  const prices = eligible.map((s) => s.purchasePrice).sort((a, b) => a - b);
  return {
    price: Number(median(prices).toFixed(2)),
    low: prices[0],
    high: prices[prices.length - 1],
    sampleSize: eligible.length,
    lastSaleAt: new Date(eligible[0].orderDate),
  };
}
