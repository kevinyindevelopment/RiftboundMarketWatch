// Daily ingest: upstream → Neon Postgres.
//
//   npm run ingest
//
// Idempotent. Re-running on the same UTC day overwrites that day's prices rather
// than duplicating them, so the scheduled job can retry freely and a manual run
// can't corrupt history.
//
// Writes over DIRECT_DATABASE_URL (see src/lib/prisma.ts). The live SSR site
// reads Neon on the next request, so data changes need NO redeploy.

import "dotenv/config";
import { collectAll, type Collected } from "../src/lib/collect";
import { prisma } from "../src/lib/prisma";

/** Neon round-trips dominate the runtime, so writes go out in batches. */
const CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function writeAll(data: Collected, log: (m: string) => void) {
  const day = new Date(`${data.date}T00:00:00.000Z`);

  const run = await prisma.ingestRun.create({
    data: { date: day, setCount: data.sets.length, source: "daily" },
  });

  // --- Sets ---------------------------------------------------------------
  // Few enough (~10) that per-row upserts are free.
  for (const set of data.sets) {
    const row = {
      name: set.name,
      abbreviation: set.abbreviation,
      publishedOn: toDate(set.publishedOn),
      isSupplemental: set.isSupplemental,
    };
    await prisma.cardSet.upsert({
      where: { groupId: set.groupId },
      create: { groupId: set.groupId, ...row },
      update: row,
    });
  }
  log(`  sets:     ${data.sets.length}`);

  // --- Products -----------------------------------------------------------
  // Prisma has no bulk upsert, so batch the per-row upserts into transactions:
  // ~1.5k sequential round-trips to Neon would otherwise dominate the run.
  let productsWritten = 0;
  for (const batch of chunk(data.products, CHUNK)) {
    await prisma.$transaction(
      batch.map((p) => {
        const row = {
          name: p.name,
          cleanName: p.cleanName,
          isSealed: p.isSealed,
          tcgplayerUrl: p.tcgplayerUrl,
          imageUrl: p.imageUrl,
          releasedOn: toDate(p.releasedOn),
          groupId: p.groupId,
          rarity: p.rarity,
          number: p.number,
          cardType: p.cardType,
          description: p.description,
          energyCost: p.energyCost,
          powerCost: p.powerCost,
          might: p.might,
          domain: p.domain,
          tags: p.tags,
          riftcodexId: p.riftcodexId,
          riftboundId: p.riftboundId,
          setCode: p.setCode,
          collectorNumber: p.collectorNumber,
          artist: p.artist,
          flavour: p.flavour,
          officialImageUrl: p.officialImageUrl,
          isAlternateArt: p.isAlternateArt,
          isSignature: p.isSignature,
          joinedBy: p.joinedBy,
        };
        return prisma.product.upsert({
          where: { productId: p.productId },
          create: { productId: p.productId, ...row },
          update: row,
        });
      }),
    );
    productsWritten += batch.length;
    log(`  products: ${productsWritten}/${data.products.length}`);
  }

  // --- Prices -------------------------------------------------------------
  // Replace-then-insert makes the day idempotent: a retry can't double-write,
  // and a corrected upstream number replaces the earlier one.
  await prisma.priceSnapshot.deleteMany({ where: { date: day } });

  // A price row for a product tcgcsv didn't list would violate the FK, so drop
  // orphans rather than failing the whole run.
  const knownProductIds = new Set(data.products.map((p) => p.productId));
  const priceRows = data.prices
    .filter((p) => knownProductIds.has(p.productId))
    .map((p) => ({
      productId: p.productId,
      subTypeName: p.subTypeName,
      date: day,
      lowPrice: p.lowPrice,
      midPrice: p.midPrice,
      highPrice: p.highPrice,
      marketPrice: p.marketPrice,
      directLowPrice: p.directLowPrice,
    }));
  const orphans = data.prices.length - priceRows.length;
  if (orphans > 0) log(`  (skipped ${orphans} price rows with no matching product)`);

  let pricesWritten = 0;
  for (const batch of chunk(priceRows, CHUNK)) {
    await prisma.priceSnapshot.createMany({ data: batch, skipDuplicates: true });
    pricesWritten += batch.length;
    log(`  prices:   ${pricesWritten}/${priceRows.length}`);
  }

  await prisma.ingestRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      productCount: data.products.length,
      priceRowCount: priceRows.length,
      ok: true,
    },
  });

  return { products: data.products.length, prices: priceRows.length };
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.DIRECT_DATABASE_URL) {
    console.error(
      "No DATABASE_URL / DIRECT_DATABASE_URL set. Copy .env.example to .env and fill in\n" +
        "your Neon connection strings, or run `npm run snapshot` for a credential-free JSON dump.",
    );
    process.exit(1);
  }

  const log = (m: string) => console.log(m);
  const data = await collectAll(log);

  console.log("Writing to Postgres…");
  const written = await writeAll(data, log);

  console.log("");
  console.log(
    `Ingest ${data.date} complete: ${written.products} products, ${written.prices} price rows.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
