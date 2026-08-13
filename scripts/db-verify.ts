// Sanity-check what's actually in the database.
//
//   npm run db:verify
//
// Cheap to run and safe on production — pure counts and a couple of small
// SELECTs. Useful after an ingest or a backfill to confirm the numbers moved.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const [sets, products, singles, sealed, prices, dayRows, joined, withArt, priced] =
    await Promise.all([
      prisma.cardSet.count(),
      prisma.product.count(),
      prisma.product.count({ where: { isSealed: false } }),
      prisma.product.count({ where: { isSealed: true } }),
      prisma.priceSnapshot.count(),
      prisma.priceSnapshot.findMany({ distinct: ["date"], select: { date: true } }),
      prisma.product.count({ where: { riftcodexId: { not: null } } }),
      prisma.product.count({ where: { officialImageUrl: { not: null } } }),
      prisma.priceSnapshot.findMany({ distinct: ["productId"], select: { productId: true } }),
    ]);

  const days = dayRows.map((d) => d.date.toISOString().slice(0, 10)).sort();

  console.log("=== ROW COUNTS ===");
  console.log(`sets             ${sets}`);
  console.log(`products         ${products}  (${singles} singles, ${sealed} sealed)`);
  console.log(`price snapshots  ${prices}`);
  console.log(`distinct products priced  ${priced.length}`);
  console.log(`riftcodex-joined ${joined}   with official art ${withArt}`);
  console.log(
    `price history    ${days.length} day(s)` +
      (days.length ? `  ${days[0]} → ${days[days.length - 1]}` : ""),
  );

  const top = await prisma.priceSnapshot.findMany({
    where: { marketPrice: { not: null }, product: { isSealed: false } },
    orderBy: { marketPrice: "desc" },
    take: 5,
    include: { product: true },
  });
  console.log("\n=== TOP 5 SINGLES BY MARKET PRICE ===");
  for (const t of top) {
    console.log(
      `  $${String(t.marketPrice).padStart(8)}  ${t.subTypeName.padEnd(6)} ${t.product.name}`,
    );
  }

  const runs = await prisma.ingestRun.findMany({ orderBy: { id: "desc" }, take: 5 });
  console.log("\n=== RECENT INGEST RUNS ===");
  for (const r of runs) {
    console.log(
      `  #${r.id} ${r.date.toISOString().slice(0, 10)} ok=${r.ok} ` +
        `products=${r.productCount} prices=${r.priceRowCount} source=${r.source}` +
        (r.note ? `\n      note: ${r.note}` : ""),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
