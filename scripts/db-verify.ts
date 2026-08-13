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
