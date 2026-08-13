// Read-side queries for the app. Every one is scoped to the latest ingested day
// so a partially-written day can never show as a 100% price crash.

import { prisma } from "./prisma";
import { cached, HOME_TTL_SECONDS } from "./cache";

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
