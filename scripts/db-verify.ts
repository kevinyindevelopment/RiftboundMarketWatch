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

  // Scope to the newest day. Without this the "top" list is ranked across all
  // 90+ stored days and just repeats whichever card is dearest, once per day.
  const latest = days.length ? new Date(`${days[days.length - 1]}T00:00:00.000Z`) : undefined;
  const top = await prisma.priceSnapshot.findMany({
    where: { date: latest, marketPrice: { not: null }, product: { isSealed: false } },
    orderBy: { marketPrice: "desc" },
    take: 5,
    include: { product: true },
  });
  console.log(`\n=== TOP 5 SINGLES BY MARKET PRICE (${days[days.length - 1] ?? "n/a"}) ===`);
  for (const t of top) {
    console.log(
      `  $${String(t.marketPrice).padStart(8)}  ${t.subTypeName.padEnd(6)} ${t.product.name}`,
    );
  }

  // Storage is billed per GB-month (see COST.md), so keep it visible. Growth is
  // driven almost entirely by PriceSnapshot: ~1.7k rows every day, forever.
  // Casts to ::text are required, not cosmetic: `relname` is the Postgres `name`
  // type and `pg_total_relation_size` returns bigint, neither of which the Neon
  // driver adapter can deserialize (P2010 UnsupportedNativeDataType).
  const sizes = await prisma.$queryRaw<
    { table: string; total: string; bytes: string }[]
  >`
    SELECT c.relname::text AS table,
           pg_size_pretty(pg_total_relation_size(c.oid))::text AS total,
           pg_total_relation_size(c.oid)::text AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `;
  const totalBytes = sizes.reduce((a, s) => a + Number(s.bytes), 0);
  console.log("\n=== STORAGE (indexes included) ===");
  for (const s of sizes) console.log(`  ${s.table.padEnd(16)} ${s.total}`);
  console.log(`  ${"TOTAL".padEnd(16)} ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  if (days.length > 1) {
    const perDay = totalBytes / days.length;
    console.log(
      `  ~${(perDay / 1024).toFixed(0)} KB/day → ~${((perDay * 365) / 1024 / 1024).toFixed(0)} MB/yr` +
        ` ≈ $${(((perDay * 365) / 1024 / 1024 / 1024) * 0.35).toFixed(2)}/mo storage at year end`,
    );
  }

  // --- Sales-derived pricing ------------------------------------------------
  const [saleCount, salePriced, saleDates] = await Promise.all([
    prisma.sale.count(),
    prisma.product.count({ where: { salePrice: { not: null } } }),
    prisma.sale.aggregate({ _min: { orderDate: true }, _max: { orderDate: true } }),
  ]);
  console.log("\n=== SALES (headline price source) ===");
  console.log(`sales stored     ${saleCount}`);
  console.log(`products priced  ${salePriced} of ${products}`);
  if (saleDates._min.orderDate) {
    console.log(
      `sale date range  ${saleDates._min.orderDate.toISOString().slice(0, 16)} → ` +
        `${saleDates._max.orderDate?.toISOString().slice(0, 16)}`,
    );
  }

  // Sample size matters: depth accumulates over time, so early on most products
  // sit below the 10-sale target. This is the number that shows it filling in.
  const buckets = await prisma.$queryRaw<{ bucket: string; n: bigint }[]>`
    SELECT CASE
             WHEN "saleSampleSize" >= 10 THEN 'full (10)'
             WHEN "saleSampleSize" >= 5  THEN '5-9'
             WHEN "saleSampleSize" >= 1  THEN '1-4'
             ELSE 'none'
           END AS bucket,
           COUNT(*)::bigint AS n
    FROM "Product" GROUP BY 1 ORDER BY 1
  `;
  console.log("sample depth:");
  for (const b of buckets) console.log(`  ${b.bucket.padEnd(10)} ${Number(b.n)}`);

  // Sanity: how far does the sales price sit from TCGplayer's own marketPrice?
  // Big divergence isn't necessarily wrong (that's the point of using sales),
  // but a systematic 10x gap would mean a unit or condition bug.
  const compare = await prisma.$queryRaw<
    { name: string; sale: number; market: number; ratio: number }[]
  >`
    SELECT p.name,
           p."salePrice" AS sale,
           ps."marketPrice" AS market,
           ROUND((p."salePrice" / NULLIF(ps."marketPrice", 0))::numeric, 2)::float8 AS ratio
    FROM "Product" p
    JOIN "PriceSnapshot" ps
      ON ps."productId" = p."productId"
     AND ps.date = (SELECT MAX(date) FROM "PriceSnapshot")
     AND ps."subTypeName" = 'Normal'
    WHERE p."salePrice" IS NOT NULL AND ps."marketPrice" > 1
    ORDER BY ABS(LOG(GREATEST(p."salePrice" / NULLIF(ps."marketPrice", 0), 0.01))) DESC
    LIMIT 6
  `;
  console.log("\nlargest sale-vs-market divergences (Normal printing):");
  for (const c of compare) {
    console.log(
      `  ${c.name.slice(0, 42).padEnd(44)} sale $${String(c.sale).padStart(8)}` +
        `  market $${String(c.market).padStart(8)}  ${c.ratio}x`,
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
