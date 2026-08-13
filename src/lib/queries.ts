// Read-side queries for the app. Every one is scoped to the latest ingested day
// so a partially-written day can never show as a 100% price crash.

import { prisma } from "./prisma";

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
  const [sets, singles, sealed, days, latest, lastRun] = await Promise.all([
    prisma.cardSet.count(),
    prisma.product.count({ where: { isSealed: false } }),
    prisma.product.count({ where: { isSealed: true } }),
    prisma.priceSnapshot
      .findMany({ distinct: ["date"], select: { date: true } })
      .then((r) => r.length),
    getLatestPriceDate(),
    prisma.ingestRun.findFirst({ where: { ok: true }, orderBy: { date: "desc" } }),
  ]);
  return { sets, singles, sealed, days, latest, lastRun };
}
