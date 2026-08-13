// Poll TCGplayer latest-sales for every product and store what's new.
//
//   npm run ingest:sales                  # every product
//   npm run ingest:sales -- --limit 50    # first 50, for testing
//   npm run ingest:sales -- --min-price 1 # skip near-worthless bulk
//
// Upstream exposes only the 5 most recent sales per product and ignores paging,
// so DEPTH IS ACCUMULATED: run hourly, store what we haven't seen, and the price
// is computed from our own growing history. See src/lib/tcgplayer-sales.ts.
//
// Idempotent — a sale's id is a hash of its natural key, so re-running inserts
// nothing new.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { fetchLatestSales, saleId, type TcgSale } from "../src/lib/tcgplayer-sales";
import { computeSalePrice, MAX_SALE_AGE_DAYS } from "../src/lib/sale-price";

/**
 * Parallel requests to TCGplayer.
 *
 * Measured ~59ms per request, so 6 in flight clears ~1,500 products in well
 * under a minute. Deliberately modest: this is an undocumented endpoint on
 * someone else's infrastructure and the job only needs to finish within the hour,
 * not as fast as possible.
 */
const CONCURRENCY = 6;

/** Pause between batches. Cheap insurance against looking like a flood. */
const BATCH_PAUSE_MS = 120;

/** DB write batch size. */
const WRITE_CHUNK = 500;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.DIRECT_DATABASE_URL) {
    console.error("No DATABASE_URL / DIRECT_DATABASE_URL set — see .env.example.");
    process.exit(1);
  }

  const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
  const minPrice = arg("--min-price") ? Number(arg("--min-price")) : undefined;
  // Recompute prices from sales already stored, without touching TCGplayer.
  // For changing the pricing rules and seeing the effect immediately, instead of
  // waiting an hour and re-polling 1,500 products to learn the same thing.
  const repriceOnly = process.argv.includes("--reprice-only");

  const products = await prisma.product.findMany({
    select: { productId: true, name: true },
    // Cheapest-first would starve the interesting cards if a run is cut short,
    // so go newest-listed first: those are the ones actually trading.
    orderBy: { productId: "desc" },
    ...(limit ? { take: limit } : {}),
  });

  // Optional: skip products whose last known market price is negligible. A $0.02
  // common trades rarely and nobody is watching its price to the hour.
  let targets = products;
  if (minPrice !== undefined) {
    const priced = await prisma.priceSnapshot.findMany({
      where: { marketPrice: { gte: minPrice } },
      distinct: ["productId"],
      select: { productId: true },
    });
    const keep = new Set(priced.map((p) => p.productId));
    targets = products.filter((p) => keep.has(p.productId));
  }

  console.log(
    repriceOnly
      ? `Repricing ${targets.length} product(s) from stored sales (no polling)`
      : `Polling ${targets.length} product(s) at concurrency ${CONCURRENCY}` +
          (minPrice !== undefined ? ` (min market price $${minPrice})` : ""),
  );

  const started = Date.now();
  const run = await prisma.ingestRun.create({
    data: { date: new Date(), source: "sales" },
  });

  const rows: {
    id: string;
    productId: number;
    orderDate: Date;
    purchasePrice: number;
    shippingPrice: number;
    quantity: number;
    condition: string;
    variant: string;
    language: string | null;
    title: string | null;
  }[] = [];

  let fetched = 0;
  let failed = 0;
  let noSales = 0;

  for (const batch of repriceOnly ? [] : chunk(targets, CONCURRENCY)) {
    await Promise.all(
      batch.map(async (p) => {
        try {
          const sales = await fetchLatestSales(p.productId);
          if (!sales || sales.length === 0) {
            noSales++;
            return;
          }
          for (const s of sales as TcgSale[]) {
            const date = new Date(s.orderDate);
            if (Number.isNaN(date.getTime())) continue;
            rows.push({
              id: saleId(p.productId, s),
              productId: p.productId,
              orderDate: date,
              purchasePrice: s.purchasePrice,
              shippingPrice: s.shippingPrice ?? 0,
              quantity: s.quantity ?? 1,
              condition: s.condition,
              variant: s.variant ?? "Normal",
              language: s.language ?? null,
              title: s.title ?? null,
            });
          }
        } catch (err) {
          failed++;
          if (failed <= 5) {
            console.warn(
              `  ${p.productId} ${p.name}: ${err instanceof Error ? err.message : err}`,
            );
          }
        } finally {
          fetched++;
          if (fetched % 250 === 0) {
            console.log(`  polled ${fetched}/${targets.length}`);
          }
        }
      }),
    );
    if (BATCH_PAUSE_MS) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
  }

  const pollMs = Date.now() - started;
  console.log(
    `Polled ${fetched} in ${(pollMs / 1000).toFixed(1)}s — ` +
      `${rows.length} sales seen, ${noSales} products with none, ${failed} failed.`,
  );

  // A sweep where EVERYTHING failed is a broken sweep, not an empty market.
  // Exit non-zero so the scheduled job goes red instead of quietly doing nothing.
  if (fetched > 0 && failed === fetched) {
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, note: `all ${failed} requests failed` },
    });
    console.error("FAILED: every request errored — upstream blocked or offline.");
    process.exit(1);
  }

  // Dedup within this sweep before hitting the DB: the same sale can appear for
  // the same product twice if a variant filter overlaps.
  const unique = new Map(rows.map((r) => [r.id, r]));
  let inserted = 0;
  for (const batch of chunk([...unique.values()], WRITE_CHUNK)) {
    const res = await prisma.sale.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
  }
  console.log(`Stored ${inserted} new sale(s) (${unique.size - inserted} already known).`);

  // --- Recompute the headline price ------------------------------------------
  // Normally only products that saw new sales; on --reprice-only, everything,
  // since the pricing rules themselves have changed.
  const touched = repriceOnly
    ? targets.map((t) => t.productId)
    : [...new Set([...unique.values()].map((r) => r.productId))];
  let repriced = 0;

  // Only sales inside the pricing window are ever relevant, and a product can
  // accumulate hundreds over time — bound the read rather than pulling history.
  const cutoff = new Date(Date.now() - MAX_SALE_AGE_DAYS * 86_400_000);

  for (const batch of chunk(touched, 50)) {
    const recent = await prisma.sale.findMany({
      where: { productId: { in: batch }, orderDate: { gte: cutoff } },
      orderBy: { orderDate: "desc" },
      select: {
        productId: true,
        purchasePrice: true,
        orderDate: true,
        condition: true,
      },
    });

    const byProduct = new Map<number, typeof recent>();
    for (const s of recent) {
      const list = byProduct.get(s.productId) ?? [];
      list.push(s);
      byProduct.set(s.productId, list);
    }

    await Promise.all(
      [...byProduct.entries()].map(async ([productId, sales]) => {
        const result = computeSalePrice(sales);
        // Write the null too. A product that drops below the sample threshold
        // must LOSE its price rather than keep the last good one forever —
        // otherwise a stale figure outlives the evidence for it.
        await prisma.product.update({
          where: { productId },
          data: {
            salePrice: result.price,
            salePriceLow: result.low,
            salePriceHigh: result.high,
            saleSampleSize: result.sampleSize,
            saleLastAt: result.lastSaleAt,
            salePriceAt: new Date(),
          },
        });
        if (result.price !== null) repriced++;
      }),
    );
  }

  // Expire prices for products that got NO new sales this run and whose last
  // sale has now aged out. They never appear in `touched`, so without this sweep
  // their price would persist indefinitely on evidence that no longer qualifies.
  const expired = await prisma.product.updateMany({
    where: { salePrice: { not: null }, saleLastAt: { lt: cutoff } },
    data: {
      salePrice: null,
      salePriceLow: null,
      salePriceHigh: null,
      saleSampleSize: 0,
      salePriceAt: new Date(),
    },
  });
  if (expired.count > 0) {
    console.log(
      `Expired ${expired.count} price(s) with no sale in ${MAX_SALE_AGE_DAYS} days.`,
    );
  }

  await prisma.ingestRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      productCount: fetched,
      priceRowCount: inserted,
      ok: true,
      note:
        `${inserted} new sales, ${repriced} repriced, ${failed} failed` +
        `, ${(pollMs / 1000).toFixed(0)}s`,
    },
  });

  console.log(`Repriced ${repriced} product(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
