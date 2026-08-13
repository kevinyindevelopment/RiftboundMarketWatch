// Read-side queries for the app. Every one is scoped to the latest ingested day
// so a partially-written day can never show as a 100% price crash.

import { prisma } from "./prisma";
import { cached, HOME_TTL_SECONDS, DEALS_TTL_SECONDS } from "./cache";
import { DEAL_THRESHOLD, MIN_WATCH_VALUE, SUSPICIOUS_DISCOUNT } from "./deals";
import {
  buildPool,
  cardPrice,
  classifyPrinting,
  isRelevant,
  type BoxCard,
  type BoxPools,
  type Printing,
} from "./box-ev";

/** The most recent day that has any price data, or null on an empty DB. */
export async function getLatestPriceDate(): Promise<Date | null> {
  const row = await prisma.priceSnapshot.findFirst({
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

export type PricedProduct = {
  productId: number;
  name: string;
  setName: string;
  rarity: string | null;
  number: string | null;
  subTypeName: string;
  marketPrice: number | null;
  imageUrl: string | null;
  tcgplayerUrl: string;
};

/** A product ranked by its best available price, with the source made explicit. */
export type ValuedProduct = {
  productId: number;
  name: string;
  setName: string;
  rarity: string | null;
  tcgplayerUrl: string;
  /** The number shown. From sales when we have enough recent ones, else market. */
  price: number;
  /** "sales" = median of recent completed sales; "market" = TCGplayer's figure. */
  source: "sales" | "market";
  sampleSize: number | null;
  lastSaleAt: Date | null;
  /**
   * Which variant the price describes, e.g. "Foil:raw".
   * A price is per (finish, grade) — foils traded up to 18x their normal
   * counterpart — so this must be shown alongside the number, never dropped.
   */
  variant: string | null;
};

/**
 * Most valuable products by *effective* price.
 *
 * Ranks on the sales-derived price where one exists and TCGplayer's market price
 * otherwise, in a single SQL pass — ordering in JS would mean pulling every
 * product to sort it. `source` is returned so the UI never presents a fallback
 * market price as though it were sales-derived.
 */
export async function getTopByValue(
  opts: { limit?: number; sealed?: boolean } = {},
): Promise<ValuedProduct[]> {
  const { limit = 20, sealed = false } = opts;

  return prisma.$queryRaw<ValuedProduct[]>`
    SELECT p."productId",
           p.name,
           s.name AS "setName",
           p.rarity,
           p."tcgplayerUrl",
           COALESCE(p."salePrice", ps."marketPrice")::float8 AS price,
           CASE WHEN p."salePrice" IS NOT NULL THEN 'sales' ELSE 'market' END AS source,
           p."saleSampleSize" AS "sampleSize",
           p."saleLastAt" AS "lastSaleAt",
           p."salePriceVariant" AS variant
    FROM "Product" p
    JOIN "CardSet" s ON s."groupId" = p."groupId"
    LEFT JOIN "PriceSnapshot" ps
      ON ps."productId" = p."productId"
     AND ps.date = (SELECT MAX(date) FROM "PriceSnapshot")
     AND ps."subTypeName" = 'Normal'
    WHERE p."isSealed" = ${sealed}
      AND COALESCE(p."salePrice", ps."marketPrice") IS NOT NULL
    ORDER BY COALESCE(p."salePrice", ps."marketPrice") DESC
    LIMIT ${limit}
  `;
}

/** Highest market price on the latest day. `sealed` filters singles vs sealed. */
export async function getTopByMarketPrice(
  opts: { limit?: number; sealed?: boolean } = {},
): Promise<PricedProduct[]> {
  const { limit = 25, sealed = false } = opts;
  const date = await getLatestPriceDate();
  if (!date) return [];

  const rows = await prisma.priceSnapshot.findMany({
    where: {
      date,
      marketPrice: { not: null },
      product: { isSealed: sealed },
    },
    orderBy: { marketPrice: "desc" },
    take: limit,
    include: { product: { include: { set: true } } },
  });

  return rows.map((r) => ({
    productId: r.productId,
    name: r.product.name,
    setName: r.product.set.name,
    rarity: r.product.rarity,
    number: r.product.number,
    subTypeName: r.subTypeName,
    marketPrice: r.marketPrice,
    imageUrl: r.product.officialImageUrl ?? r.product.imageUrl,
    tcgplayerUrl: r.product.tcgplayerUrl,
  }));
}

export type Mover = PricedProduct & {
  previousPrice: number;
  changePct: number;
};

/**
 * Biggest market-price movers between the latest day and the most recent prior
 * day that has data.
 *
 * Compares against the previous AVAILABLE day rather than "yesterday": the
 * scheduled job can miss a run, and a gap would otherwise silently return zero
 * movers. Returns [] until there are at least two days of history.
 */
export async function getTopMovers(
  opts: { limit?: number; minPrice?: number } = {},
): Promise<Mover[]> {
  const { limit = 25, minPrice = 1 } = opts;
  const latest = await getLatestPriceDate();
  if (!latest) return [];

  const prior = await prisma.priceSnapshot.findFirst({
    where: { date: { lt: latest } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (!prior) return [];

  const [today, before] = await Promise.all([
    prisma.priceSnapshot.findMany({
      where: { date: latest, marketPrice: { not: null } },
      include: { product: { include: { set: true } } },
    }),
    prisma.priceSnapshot.findMany({
      where: { date: prior.date, marketPrice: { not: null } },
      select: { productId: true, subTypeName: true, marketPrice: true },
    }),
  ]);

  // Key on (productId, subTypeName): Normal and Foil move independently.
  const priorByKey = new Map(
    before.map((r) => [`${r.productId}|${r.subTypeName}`, r.marketPrice!]),
  );

  const movers: Mover[] = [];
  for (const r of today) {
    const was = priorByKey.get(`${r.productId}|${r.subTypeName}`);
    // Skip cheap cards: a $0.05 -> $0.15 common is +200% and pure noise.
    if (was == null || was < minPrice) continue;
    const now = r.marketPrice!;
    movers.push({
      productId: r.productId,
      name: r.product.name,
      setName: r.product.set.name,
      rarity: r.product.rarity,
      number: r.product.number,
      subTypeName: r.subTypeName,
      marketPrice: now,
      imageUrl: r.product.officialImageUrl ?? r.product.imageUrl,
      tcgplayerUrl: r.product.tcgplayerUrl,
      previousPrice: was,
      changePct: ((now - was) / was) * 100,
    });
  }

  movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return movers.slice(0, limit);
}

/** Headline counts for the homepage. */
export async function getSummary() {
  const [sets, singles, sealed, days, latest] = await Promise.all([
    prisma.cardSet.count(),
    prisma.product.count({ where: { isSealed: false } }),
    prisma.product.count({ where: { isSealed: true } }),
    prisma.priceSnapshot
      .findMany({ distinct: ["date"], select: { date: true } })
      .then((r) => r.length),
    getLatestPriceDate(),
  ]);
  return { sets, singles, sealed, days, latest };
}

/**
 * Everything the homepage needs, in ONE cached, JSON-safe payload.
 *
 * The cache is the point: without it every visitor runs these five queries and
 * wakes Neon for the full 5-minute scale-to-zero window (see COST.md). With it,
 * the database is touched roughly once per region per hour regardless of traffic.
 *
 * `latest` is deliberately an ISO string, not a Date — the cached value round-
 * trips through JSON, and a Date would silently come back as a string on a cache
 * hit but stay a Date on a miss. Normalising here keeps both paths identical.
 */
export async function getHomeData() {
  // v3: rows now carry the variant the price describes.
  return cached("home:v3", HOME_TTL_SECONDS, async () => {
    const [summary, topSingles, topSealed, movers, salesStats] = await Promise.all([
      getSummary(),
      getTopByValue({ limit: 20, sealed: false }),
      getTopByValue({ limit: 10, sealed: true }),
      getTopMovers({ limit: 20 }),
      getSalesCoverage(),
    ]);
    return {
      summary: {
        ...summary,
        latest: summary.latest ? summary.latest.toISOString().slice(0, 10) : null,
      },
      salesStats,
      // Dates are normalised to ISO strings before caching — see cache.ts.
      topSingles: topSingles.map((p) => ({
        ...p,
        lastSaleAt: p.lastSaleAt ? new Date(p.lastSaleAt).toISOString() : null,
      })),
      topSealed: topSealed.map((p) => ({
        ...p,
        lastSaleAt: p.lastSaleAt ? new Date(p.lastSaleAt).toISOString() : null,
      })),
      movers,
    };
  });
}

export type DealRow = {
  listingId: string;
  productId: number;
  name: string;
  setName: string;
  rarity: string | null;
  finish: string;
  listingPrice: number;
  shippingPrice: number;
  quantity: number;
  benchmarkPrice: number;
  /** "sales" = median of recent sales; "market" = TCGplayer's market price. */
  benchmarkSource: "sales" | "market";
  sampleSize: number | null;
  discount: number;
  savings: number;
  /** Savings after the seller's shipping — what you actually gain. */
  netSavings: number;
  /** Implausibly cheap — likely mis-listed. Shown, but ranked below real deals. */
  suspicious: boolean;
  sellerName: string | null;
  sellerRating: number | null;
  tcgplayerUrl: string;
};

/**
 * Active listings priced at least `threshold` below what the card is worth.
 *
 * Every comparison is like-for-like, which is the only thing that makes this
 * meaningful:
 *   - Listings are pre-filtered at ingest to **Near Mint, English** only, so a
 *     played or Chinese copy can never appear as a bargain (see deals.ts).
 *   - The benchmark is matched on **finish** — Normal against Normal, Foil
 *     against Foil. Those diverge by up to 18x, so a cross-finish comparison
 *     would fabricate enormous fake discounts.
 *   - Benchmark prefers the sales-derived price and falls back to TCGplayer's
 *     market price, with `benchmarkSource` saying which, so a deal measured
 *     against the weaker number is never presented as though it weren't.
 *
 * Eligibility mirrors deals.ts: Epic/Showcase rarity, or worth over $1.
 */
export async function getDeals(
  opts: { limit?: number; threshold?: number; only?: "credible" | "suspicious" } = {},
): Promise<DealRow[]> {
  const { limit = 100, threshold = DEAL_THRESHOLD, only } = opts;
  // Filter in SQL rather than slicing after LIMIT. Sorting suspicious rows last
  // and then truncating hides them entirely whenever there are enough credible
  // deals to fill the page — which silently breaks the promise to show them.
  const minDiscount = only === "suspicious" ? SUSPICIOUS_DISCOUNT : threshold;
  const maxDiscount = only === "credible" ? SUSPICIOUS_DISCOUNT : 1.1;

  const rows = await prisma.$queryRaw<(Omit<DealRow, "listingId"> & { listingId: bigint })[]>`
    WITH benchmark AS (
      SELECT l."listingId",
             l."productId",
             l.finish,
             l.price          AS "listingPrice",
             l."shippingPrice",
             l.quantity,
             l."sellerName",
             l."sellerRating",
             COALESCE(vp.price, ps."marketPrice")::float8 AS "benchmarkPrice",
             CASE WHEN vp.price IS NOT NULL THEN 'sales' ELSE 'market' END AS "benchmarkSource",
             vp."sampleSize"
      FROM "Listing" l
      -- Same finish, ungraded: TCGplayer sells raw singles.
      LEFT JOIN "ProductPrice" vp
        ON vp."productId" = l."productId"
       AND vp.finish      = l.finish
       AND vp."gradeKey"  = 'raw'
      -- Fallback benchmark, matched on finish via subTypeName.
      LEFT JOIN "PriceSnapshot" ps
        ON ps."productId"   = l."productId"
       AND ps."subTypeName" = l.finish
       AND ps.date = (SELECT MAX(date) FROM "PriceSnapshot")
    )
    SELECT b."listingId",
           b."productId",
           p.name,
           s.name AS "setName",
           p.rarity,
           b.finish,
           b."listingPrice",
           b."shippingPrice",
           b.quantity,
           b."benchmarkPrice",
           b."benchmarkSource",
           b."sampleSize",
           ((b."benchmarkPrice" - b."listingPrice") / b."benchmarkPrice")::float8 AS discount,
           ROUND((b."benchmarkPrice" - b."listingPrice")::numeric, 2)::float8 AS savings,
           ROUND((b."benchmarkPrice" - b."listingPrice" - b."shippingPrice")::numeric, 2)::float8
             AS "netSavings",
           ((b."benchmarkPrice" - b."listingPrice") / b."benchmarkPrice" >= ${SUSPICIOUS_DISCOUNT})
             AS suspicious,
           b."sellerName",
           b."sellerRating",
           p."tcgplayerUrl"
    FROM benchmark b
    JOIN "Product" p ON p."productId" = b."productId"
    JOIN "CardSet" s ON s."groupId"   = p."groupId"
    WHERE b."benchmarkPrice" IS NOT NULL
      AND b."benchmarkPrice" > 0
      AND (b."benchmarkPrice" - b."listingPrice") / b."benchmarkPrice" >= ${minDiscount}
      AND (b."benchmarkPrice" - b."listingPrice") / b."benchmarkPrice" <  ${maxDiscount}
      -- Shipping must not eat the saving. A penny common at 71% off "saves"
      -- $0.37 and costs $1.49 to post — a percentage, not a deal.
      AND (b."benchmarkPrice" - b."listingPrice" - b."shippingPrice") > 0
      -- Eligibility: high rarity, or actually worth something.
      AND (p.rarity IN ('Epic', 'Showcase') OR b."benchmarkPrice" > ${MIN_WATCH_VALUE})
    -- Credible deals first. Ranking purely by discount would park mis-listings
    -- (90%+ off, never sell) permanently at the top and bury the actionable ones.
    ORDER BY suspicious ASC, discount DESC, savings DESC
    LIMIT ${limit}
  `;

  // BigInt ids can't be JSON-serialised into the cache or a client component.
  return rows.map((r) => ({ ...r, listingId: r.listingId.toString() }));
}

/** Headline counts for the landing menu. */
export async function getMenuStats() {
  return cached("menu:v1", HOME_TTL_SECONDS, async () => {
    const [products, sales, listings, deals] = await Promise.all([
      prisma.product.count(),
      prisma.sale.count(),
      prisma.listing.count(),
      getDeals({ limit: 500, only: "credible" }).then((d) => d.length),
    ]);
    return { products, sales, listings, deals };
  });
}

/**
 * Everything the deals page renders, cached as one payload.
 *
 * TTL is shorter than the homepage's because listings are volatile — but still
 * long enough that traffic can't wake Neon per visitor (see COST.md). Listings
 * only refresh hourly upstream, so a stale window here costs no accuracy.
 */
export async function getDealsPageData() {
  return cached("deals:v2", DEALS_TTL_SECONDS, async () => {
    const [credible, flagged, listings, watched, lastRun] = await Promise.all([
      getDeals({ limit: 120, only: "credible" }),
      // Queried separately with its own budget so the flagged list is always
      // represented, however many credible deals exist.
      getDeals({ limit: 30, only: "suspicious" }),
      prisma.listing.count(),
      prisma.product.count({
        where: {
          OR: [
            { isSealed: false, rarity: { in: ["Epic", "Showcase"] } },
            { salePrice: { gt: MIN_WATCH_VALUE } },
          ],
        },
      }),
      prisma.ingestRun.findFirst({
        where: { source: "listings", ok: true },
        orderBy: { id: "desc" },
        select: { finishedAt: true },
      }),
    ]);
    return {
      deals: [...credible, ...flagged],
      stats: {
        listings,
        watched,
        checkedAt: lastRun?.finishedAt
          ? lastRun.finishedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC"
          : null,
      },
    };
  });
}

/** One row per card as the box-EV maths consumes it. */
type BoxEvQueryRow = {
  productId: number;
  name: string;
  setCode: string | null;
  setName: string;
  rarity: string | null;
  number: string | null;
  tcgplayerUrl: string;
  normalSale: number | null;
  normalMarket: number | null;
  foilSale: number | null;
  foilMarket: number | null;
};

export type RelevantCard = {
  productId: number;
  name: string;
  rarity: string | null;
  number: string | null;
  printing: Printing;
  normalPrice: number | null;
  foilPrice: number | null;
  normalFromSales: boolean;
  foilFromSales: boolean;
  tcgplayerUrl: string;
};

export type BoxEvSet = {
  setCode: string;
  setName: string;
  /** The sealed booster display this EV is compared against, if we price one. */
  boxName: string | null;
  boxPrice: number | null;
  boxPriceSource: "sales" | "market" | null;
  boxUrl: string | null;
  packPrice: number | null;
  pools: BoxPools;
  /** Epic+ or $1+, sorted dearest first. Everything else is bulk. */
  relevantCards: RelevantCard[];
  /**
   * Cards left out of every slot because no pull rate for them was supplied —
   * listed rather than dropped so their absence from the EV is visible.
   */
  excluded: { name: string; rarity: string | null; price: number | null }[];
  coverage: { singles: number; priced: number };
};

/**
 * Everything the box-EV page needs, in ONE cached payload.
 *
 * Two joins per finish, not one: a card's price is `ProductPrice` (median of
 * recent sales) where we have enough sales and the day's `PriceSnapshot` market
 * price otherwise — the same fallback the rest of the site uses, with the source
 * carried through so the page can label it. Both finishes are fetched because
 * Common/Uncommon exist in Normal *and* Foil and the pack's foil slot needs the
 * latter, while Rare and above exist only as Foil (see box-ev.ts).
 */
export async function getBoxEvPageData() {
  return cached("boxev:v1", HOME_TTL_SECONDS, async () => {
    const [cards, sealed] = await Promise.all([
      prisma.$queryRaw<BoxEvQueryRow[]>`
        SELECT p."productId", p.name, s.abbreviation AS "setCode", s.name AS "setName",
               p.rarity, p.number, p."tcgplayerUrl",
               pn.price::float8         AS "normalSale",
               sn."marketPrice"::float8 AS "normalMarket",
               pf.price::float8         AS "foilSale",
               sf."marketPrice"::float8 AS "foilMarket"
        FROM "Product" p
        JOIN "CardSet" s ON s."groupId" = p."groupId"
        LEFT JOIN "ProductPrice" pn
          ON pn."productId" = p."productId" AND pn.finish = 'Normal' AND pn."gradeKey" = 'raw'
        LEFT JOIN "ProductPrice" pf
          ON pf."productId" = p."productId" AND pf.finish = 'Foil'   AND pf."gradeKey" = 'raw'
        LEFT JOIN "PriceSnapshot" sn
          ON sn."productId" = p."productId" AND sn."subTypeName" = 'Normal'
         AND sn.date = (SELECT MAX(date) FROM "PriceSnapshot")
        LEFT JOIN "PriceSnapshot" sf
          ON sf."productId" = p."productId" AND sf."subTypeName" = 'Foil'
         AND sf.date = (SELECT MAX(date) FROM "PriceSnapshot")
        WHERE p."isSealed" = false
          -- Only sets that actually come in booster packs. Promo-only groups
          -- (PR/OPP/JDG) have no box to open.
          AND s."groupId" IN (
            SELECT "groupId" FROM "Product"
            WHERE "isSealed" = true AND name LIKE '%- Booster Display'
          )
      `,
      prisma.$queryRaw<
        Array<{
          setCode: string | null;
          name: string;
          tcgplayerUrl: string;
          price: number | null;
          source: "sales" | "market";
        }>
      >`
        SELECT s.abbreviation AS "setCode", p.name, p."tcgplayerUrl",
               COALESCE(p."salePrice", ps."marketPrice")::float8 AS price,
               CASE WHEN p."salePrice" IS NOT NULL THEN 'sales' ELSE 'market' END AS source
        FROM "Product" p
        JOIN "CardSet" s ON s."groupId" = p."groupId"
        LEFT JOIN "PriceSnapshot" ps
          ON ps."productId" = p."productId" AND ps."subTypeName" = 'Normal'
         AND ps.date = (SELECT MAX(date) FROM "PriceSnapshot")
        WHERE p."isSealed" = true
          AND (p.name LIKE '%- Booster Display' OR p.name LIKE '%- Booster Pack')
      `,
    ]);

    const bySet = new Map<string, BoxEvQueryRow[]>();
    for (const c of cards) {
      const key = c.setCode ?? c.setName;
      if (!bySet.has(key)) bySet.set(key, []);
      bySet.get(key)!.push(c);
    }

    const sets: BoxEvSet[] = [];
    for (const [setCode, rows] of bySet) {
      const box = sealed.find((s) => s.setCode === setCode && s.name.endsWith("- Booster Display"));
      const pack = sealed.find((s) => s.setCode === setCode && s.name.endsWith("- Booster Pack"));

      const cardsForSet: BoxCard[] = rows.map((r) => ({
        productId: r.productId,
        name: r.name,
        rarity: r.rarity,
        number: r.number,
        printing: classifyPrinting(r.name, r.rarity, r.number),
        normalPrice: r.normalSale ?? r.normalMarket,
        foilPrice: r.foilSale ?? r.foilMarket,
        normalFromSales: r.normalSale != null,
        foilFromSales: r.foilSale != null,
        tcgplayerUrl: r.tcgplayerUrl,
      }));

      const base = (rarity: string) =>
        cardsForSet.filter((c) => c.printing === "base" && c.rarity === rarity);
      const printed = (printing: Printing) => cardsForSet.filter((c) => c.printing === printing);

      const pools: BoxPools = {
        common: buildPool(base("Common"), "base"),
        uncommon: buildPool(base("Uncommon"), "base"),
        // Rare and Epic have no Normal printing at all — the foil price is the
        // only price they have, not a premium version of a cheaper one.
        rare: buildPool(base("Rare"), "foil"),
        epic: buildPool(base("Epic"), "foil"),
        altArt: buildPool(printed("alt-art"), "foil"),
        overnumbered: buildPool(printed("overnumbered"), "foil"),
        signature: buildPool(printed("signature"), "foil"),
        foilCommon: buildPool(base("Common"), "foil"),
        foilUncommon: buildPool(base("Uncommon"), "foil"),
      };

      const relevantCards = cardsForSet
        .filter(
          (c) =>
            c.printing !== "rune" &&
            c.printing !== "other" &&
            (isRelevant(c.rarity, c.printing, cardPrice(c, "base")) ||
              isRelevant(c.rarity, c.printing, c.foilPrice)),
        )
        .map((c) => ({
          productId: c.productId,
          name: c.name,
          rarity: c.rarity,
          number: c.number,
          printing: c.printing,
          normalPrice: c.normalPrice,
          foilPrice: c.foilPrice,
          normalFromSales: c.normalFromSales,
          foilFromSales: c.foilFromSales,
          tcgplayerUrl: c.tcgplayerUrl,
        }))
        .sort(
          (a, b) =>
            Math.max(b.foilPrice ?? 0, b.normalPrice ?? 0) -
            Math.max(a.foilPrice ?? 0, a.normalPrice ?? 0),
        );

      const excluded = cardsForSet
        .filter((c) => c.printing === "other")
        .map((c) => ({
          name: c.name,
          rarity: c.rarity,
          price: c.foilPrice ?? c.normalPrice,
        }))
        .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));

      sets.push({
        setCode,
        setName: rows[0].setName,
        boxName: box?.name ?? null,
        boxPrice: box?.price ?? null,
        boxPriceSource: box ? box.source : null,
        boxUrl: box?.tcgplayerUrl ?? null,
        packPrice: pack?.price ?? null,
        pools,
        relevantCards,
        excluded,
        coverage: {
          singles: cardsForSet.length,
          priced: cardsForSet.filter((c) => c.normalPrice != null || c.foilPrice != null).length,
        },
      });
    }

    // Newest set first — that's the box people are actually deciding about.
    sets.sort((a, b) => (b.boxPrice ?? 0) - (a.boxPrice ?? 0));

    const latest = await getLatestPriceDate();
    return { sets, latest: latest ? latest.toISOString().slice(0, 10) : null };
  });
}

/** How much of the catalogue is priced from real sales rather than fallback. */
export async function getSalesCoverage() {
  const [sales, priced, total, newest] = await Promise.all([
    prisma.sale.count(),
    prisma.product.count({ where: { salePrice: { not: null } } }),
    prisma.product.count(),
    prisma.sale.findFirst({ orderBy: { orderDate: "desc" }, select: { orderDate: true } }),
  ]);
  return {
    sales,
    priced,
    total,
    newestSaleAt: newest?.orderDate ? newest.orderDate.toISOString() : null,
  };
}
