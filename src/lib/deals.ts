// Deal detection: an active listing priced meaningfully below what the card is
// actually worth.
//
// The whole feature hinges on comparing LIKE WITH LIKE. Our prices are the
// median of recent **Near Mint, English** sales for a specific **finish**. A
// listing is only a deal if it is the same thing on every one of those axes —
// otherwise we'd be "discovering" that damaged cards and foreign printings are
// cheaper than mint English ones, which is not a deal, it's a different product.

/** A listing is only comparable to our price if it is Near Mint. */
export const DEAL_CONDITIONS = new Set(["Near Mint", "Unopened"]);

/**
 * Only English listings.
 *
 * Chinese/Japanese printings trade at genuinely different levels, so against an
 * English NM benchmark they would look like permanent 40-70% "deals" and flood
 * the board with noise that can never be acted on.
 */
export const DEAL_LANGUAGE = "English";

/** Minimum discount to count as a deal. */
export const DEAL_THRESHOLD = 0.2;

/**
 * Above this discount, a listing is more likely mis-listed than mispriced.
 *
 * Observed on the Worlds Bundle 2025: five sales all landed at ~$1,000 while six
 * live listings sat at $50–$120, one seller holding TEN copies at $110. A real
 * $1,000 item at 90% off is bought within minutes — the fact that these persist
 * across polls is the evidence that they aren't the same item (wrong product,
 * a single promo card from the bundle, or bait).
 *
 * These are FLAGGED, not hidden: the request was to show everything 20% below,
 * and silently dropping listings would hide genuine finds too. But they sort
 * below verified deals, because otherwise the top of the board is permanently
 * occupied by noise and the actionable 25–40% deals are buried underneath.
 */
export const SUSPICIOUS_DISCOUNT = 0.75;

/** Rarities always watched, regardless of price. */
export const HIGH_RARITIES = new Set(["Epic", "Showcase"]);

/** Products cheaper than this are only watched if they're high rarity. */
export const MIN_WATCH_VALUE = 1;

export type DealListing = {
  condition: string;
  language: string;
  printing: string;
  price: number;
  shippingPrice?: number | null;
  quantity?: number | null;
  /** "standard" | "custom" — see isCatalogueListing. */
  listingType?: string | null;
  customTitle?: string | null;
};

/**
 * Is this listing actually the catalogue product?
 *
 * TCGplayer lets sellers attach **custom listings** to a product page with their
 * own title, description and photos. Those are not required to be the same item.
 * Observed on "Spiritforged - Booster Display" (benchmark $187): a dozen custom
 * listings at $35–95, titled "CHINESE - Spiritforged Booster Box - SLIM"
 * (24 packs × 5 cards) and "CHINESE … JUMBO" (12 packs × 14 cards) — a different
 * print run AND a different box configuration, sold under the English box's page.
 *
 * The listing's `language` field is NO help here: all 7,021 listings we collected
 * reported "English", including every Chinese box. The structural
 * `listingType` is the reliable discriminator, and it generalises — it excludes
 * bundles, misgraded lots and re-boxed product too, not just foreign printings.
 *
 * `customTitle` is checked as well, so that if custom listings are ever admitted
 * deliberately, an explicit foreign-language marker still disqualifies them.
 */
const FOREIGN_MARKERS =
  /\b(chinese|japanese|korean|simplified|traditional|jp|cn|kr)\b/i;

export function isCatalogueListing(listing: DealListing): boolean {
  if (listing.listingType && listing.listingType.toLowerCase() !== "standard") {
    return false;
  }
  if (listing.customTitle && FOREIGN_MARKERS.test(listing.customTitle)) {
    return false;
  }
  return true;
}

/**
 * Is this listing comparable to a Near Mint English benchmark price?
 *
 * Deliberately an allow-list, not a block-list of "Damaged". TCGplayer grades
 * run Near Mint / Lightly Played / Moderately Played / Heavily Played / Damaged,
 * and every tier below Near Mint sells at a discount for a reason. Blocking only
 * "Damaged" would still let Heavily Played copies masquerade as bargains.
 */
export function isComparableListing(listing: DealListing): boolean {
  return (
    isCatalogueListing(listing) &&
    DEAL_CONDITIONS.has(listing.condition) &&
    listing.language === DEAL_LANGUAGE &&
    Number.isFinite(listing.price) &&
    listing.price > 0
  );
}

/** Does this product qualify for the watch list at all? */
export function isWatchedProduct(product: {
  rarity?: string | null;
  price?: number | null;
}): boolean {
  if (product.rarity && HIGH_RARITIES.has(product.rarity)) return true;
  return (product.price ?? 0) > MIN_WATCH_VALUE;
}

export type Deal = {
  listingPrice: number;
  benchmarkPrice: number;
  /** 0.25 = listed 25% below the benchmark. */
  discount: number;
  savings: number;
  /** Savings after the seller's shipping. Negative means it isn't a deal. */
  netSavings: number;
  /** Too good to be true — see SUSPICIOUS_DISCOUNT. */
  suspicious: boolean;
};

/**
 * Score a listing against the benchmark price for its OWN finish.
 *
 * `benchmarkPrice` must be the price of the same finish (Normal vs Foil) — those
 * diverge by up to 18x, so comparing a Normal listing against a Foil benchmark
 * would manufacture enormous fake discounts.
 *
 * Shipping is excluded on both sides: our sale prices are per-unit excluding
 * shipping, so including it here would compare different quantities.
 */
export function scoreDeal(
  listing: DealListing,
  benchmarkPrice: number | null | undefined,
  threshold: number = DEAL_THRESHOLD,
): Deal | null {
  if (!benchmarkPrice || benchmarkPrice <= 0) return null;
  if (!isComparableListing(listing)) return null;

  const discount = (benchmarkPrice - listing.price) / benchmarkPrice;
  if (discount < threshold) return null;

  const savings = Number((benchmarkPrice - listing.price).toFixed(2));
  const netSavings = Number((savings - (listing.shippingPrice ?? 0)).toFixed(2));

  // Shipping decides whether a percentage is real money. A penny common at 71%
  // off "saves" $0.37 while costing $1.49 to post — you end up paying triple
  // what the card is worth. Percentage discounts on cheap cards are noise, and
  // this removes them without an arbitrary price floor.
  if (netSavings <= 0) return null;

  return {
    listingPrice: listing.price,
    benchmarkPrice,
    discount,
    savings,
    netSavings,
    suspicious: discount >= SUSPICIOUS_DISCOUNT,
  };
}
