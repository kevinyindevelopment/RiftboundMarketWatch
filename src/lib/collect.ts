// Fetch + join the two upstream sources into the shape we actually store.
//
// Deliberately has NO database dependency: `scripts/snapshot.ts` runs this with
// zero credentials to dump JSON, and `scripts/ingest.ts` runs the same code and
// writes the result to Postgres. Keeping the fetch/join pure means the ingest and
// the offline snapshot can never drift apart.

import {
  fetchGroups,
  fetchPrices,
  fetchProducts,
  extField,
  type TcgcsvProduct,
} from "./tcgcsv";
import {
  fetchAllCards,
  indexByTcgplayerId,
  indexByRiftboundId,
  deriveRiftboundId,
  type RiftcodexCard,
} from "./riftcodex";

export type CollectedSet = {
  groupId: number;
  name: string;
  abbreviation: string | null;
  publishedOn: string | null;
  isSupplemental: boolean;
};

export type CollectedProduct = {
  productId: number;
  groupId: number;
  name: string;
  cleanName: string;
  /** Sealed product (booster box, bundle) vs. a single card. */
  isSealed: boolean;
  tcgplayerUrl: string;
  imageUrl: string | null;
  releasedOn: string | null;

  // --- from TCGplayer extendedData (singles only) ---
  rarity: string | null;
  number: string | null;
  cardType: string | null;
  description: string | null;
  energyCost: string | null;
  powerCost: string | null;
  might: string | null;
  domain: string | null;
  tags: string | null;

  // --- from Riftcodex, joined on tcgplayer_id ---
  riftcodexId: string | null;
  riftboundId: string | null;
  setCode: string | null;
  collectorNumber: number | null;
  artist: string | null;
  flavour: string | null;
  officialImageUrl: string | null;
  isAlternateArt: boolean | null;
  isSignature: boolean | null;
  /** How the Riftcodex row was found: null when unjoined. */
  joinedBy: "tcgplayer_id" | "riftbound_id" | null;
};

export type CollectedPrice = {
  productId: number;
  subTypeName: string;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  directLowPrice: number | null;
};

export type Collected = {
  /** UTC day this snapshot represents (YYYY-MM-DD) — the price history key. */
  date: string;
  fetchedAt: string;
  sets: CollectedSet[];
  products: CollectedProduct[];
  prices: CollectedPrice[];
  stats: {
    sets: number;
    products: number;
    singles: number;
    sealed: number;
    priceRows: number;
    productsWithPrice: number;
    riftcodexCards: number;
    matchedToRiftcodex: number;
    matchedByTcgplayerId: number;
    matchedByRiftboundId: number;
  };
};

/**
 * The UTC day to file a price snapshot under.
 *
 * tcgcsv refreshes ~20:00 UTC and its `/prices` payload carries no timestamp of
 * its own, so we stamp with our own fetch day. Using UTC (not local time) keeps
 * the GitHub Actions runner and a local Windows run from writing two different
 * dates for the same underlying data.
 */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function normalizeProduct(
  product: TcgcsvProduct,
  card: RiftcodexCard | undefined,
  joinedBy: CollectedProduct["joinedBy"],
): CollectedProduct {
  // TCGplayer only populates extendedData for singles, so an empty array is a
  // reliable sealed-product signal (booster packs, boxes, bundles, sleeves).
  const isSealed = product.extendedData.length === 0;

  return {
    productId: product.productId,
    groupId: product.groupId,
    name: product.name,
    cleanName: product.cleanName,
    isSealed,
    tcgplayerUrl: product.url,
    imageUrl: product.imageUrl ?? null,
    releasedOn: product.presaleInfo?.releasedOn ?? null,

    rarity: extField(product, "Rarity") ?? null,
    number: extField(product, "Number") ?? null,
    cardType: extField(product, "Card Type") ?? null,
    description: extField(product, "Description") ?? null,
    energyCost: extField(product, "Energy Cost") ?? null,
    powerCost: extField(product, "Power Cost") ?? null,
    might: extField(product, "Might") ?? null,
    domain: extField(product, "Domain") ?? null,
    tags: extField(product, "Tag") ?? null,

    riftcodexId: card?.id ?? null,
    riftboundId: card?.riftbound_id ?? null,
    setCode: card?.set?.set_id ?? null,
    collectorNumber: card?.collector_number ?? null,
    artist: card?.media?.artist ?? null,
    flavour: card?.text?.flavour ?? null,
    officialImageUrl: card?.media?.image_url ?? null,
    isAlternateArt: card?.metadata?.alternate_art ?? null,
    isSignature: card?.metadata?.signature ?? null,
    joinedBy: card ? joinedBy : null,
  };
}

/**
 * Pull every Riftbound set, product and current price, enriched with Riftcodex.
 *
 * Cost is bounded and small: 1 groups call + 2 calls per group (~10 groups) + ~15
 * Riftcodex pages. Roughly 36 requests total, so there's no rate limiting or
 * incremental-skip logic here — a full refresh is cheap enough to just redo.
 */
export async function collectAll(
  log: (msg: string) => void = () => {},
): Promise<Collected> {
  const fetchedAt = new Date();

  log("Fetching Riftcodex card metadata…");
  const cards = await fetchAllCards((n, total) =>
    log(`  cards ${n}/${total}`),
  );
  const cardsByProductId = indexByTcgplayerId(cards);
  const cardsByRiftboundId = indexByRiftboundId(cards);
  log(`  ${cards.length} cards (${cardsByProductId.size} with a TCGplayer id)`);

  log("Fetching TCGplayer sets…");
  const groups = await fetchGroups();
  log(`  ${groups.length} sets`);

  const products: CollectedProduct[] = [];
  const prices: CollectedPrice[] = [];

  for (const group of groups) {
    // Sequential per set: ~10 sets, and it keeps the progress log readable.
    const [groupProducts, groupPrices] = await Promise.all([
      fetchProducts(group.groupId),
      fetchPrices(group.groupId),
    ]);

    for (const product of groupProducts) {
      // Primary join: Riftcodex's own tcgplayer_id. Fallback: rebuild the
      // riftbound_id from this set's code + the printed collector number, which
      // covers cards Riftcodex hasn't hand-linked yet (a whole new set, at
      // first). tcgcsv's group abbreviation IS the Riftcodex set code ("VEN"),
      // so no hardcoded group->set table is needed; promo groups (PR/OPP/JDG)
      // simply have no Riftcodex counterpart and fall through unjoined.
      let card = cardsByProductId.get(product.productId);
      let joinedBy: CollectedProduct["joinedBy"] = "tcgplayer_id";
      if (!card) {
        const derived = deriveRiftboundId(
          group.abbreviation,
          extField(product, "Number"),
        );
        if (derived) {
          card = cardsByRiftboundId.get(derived);
          joinedBy = "riftbound_id";
        }
      }
      products.push(normalizeProduct(product, card, joinedBy));
    }
    for (const price of groupPrices) {
      prices.push({
        productId: price.productId,
        subTypeName: price.subTypeName,
        lowPrice: price.lowPrice,
        midPrice: price.midPrice,
        highPrice: price.highPrice,
        marketPrice: price.marketPrice,
        directLowPrice: price.directLowPrice,
      });
    }

    log(
      `  ${group.abbreviation ?? group.groupId} ${group.name}: ` +
        `${groupProducts.length} products, ${groupPrices.length} price rows`,
    );
  }

  const pricedProductIds = new Set(prices.map((p) => p.productId));

  return {
    date: utcDay(fetchedAt),
    fetchedAt: fetchedAt.toISOString(),
    sets: groups.map((g) => ({
      groupId: g.groupId,
      name: g.name,
      abbreviation: g.abbreviation,
      publishedOn: g.publishedOn ?? null,
      isSupplemental: Boolean(g.isSupplemental),
    })),
    products,
    prices,
    stats: {
      sets: groups.length,
      products: products.length,
      singles: products.filter((p) => !p.isSealed).length,
      sealed: products.filter((p) => p.isSealed).length,
      priceRows: prices.length,
      productsWithPrice: pricedProductIds.size,
      riftcodexCards: cards.length,
      matchedToRiftcodex: products.filter((p) => p.riftcodexId).length,
      matchedByTcgplayerId: products.filter((p) => p.joinedBy === "tcgplayer_id").length,
      matchedByRiftboundId: products.filter((p) => p.joinedBy === "riftbound_id").length,
    },
  };
}
