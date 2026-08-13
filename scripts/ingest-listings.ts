// Poll active TCGplayer listings for watched products — the deals feed.
//
//   npm run ingest:listings
//   npm run ingest:listings -- --limit 50
//
// Only WATCHED products are polled (Epic/Showcase rarity, or worth over $1):
// ~633 of 1,534. A deal on a 5-cent common isn't actionable, and polling the
// whole catalogue would double the load on an undocumented endpoint for nothing.
//
// Listings are replaced, not accumulated — see the `Listing` model.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { fetchListings } from "../src/lib/tcgplayer-listings";
import {
  isComparableListing,
  HIGH_RARITIES,
  MIN_WATCH_VALUE,
} from "../src/lib/deals";

const CONCURRENCY = 6;
const BATCH_PAUSE_MS = 120;

/**
 * Listings kept per product.
 *
 * Only the cheap end can contain a deal, and the feed is already sorted by
 * price+shipping ascending, so a shallow slice is enough. Keeping more would
 * store thousands of rows nobody will ever look at.
 */
const KEEP_PER_PRODUCT = 12;

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

  // The watch list, resolved in SQL so it stays consistent with deals.ts.
  const watched = await prisma.product.findMany({
    where: {
      OR: [
        { isSealed: false, rarity: { in: [...HIGH_RARITIES] } },
        { salePrice: { gt: MIN_WATCH_VALUE } },
      ],
    },
    select: { productId: true, name: true },
    orderBy: { salePrice: "desc" },
    ...(limit ? { take: limit } : {}),
  });

  console.log(`Polling listings for ${watched.length} watched product(s)`);
  const started = Date.now();
  const run = await prisma.ingestRun.create({
    data: { date: new Date(), source: "listings" },
  });

  const rows: {
    listingId: bigint;
    productId: number;
    finish: string;
    condition: string;
    language: string;
    price: number;
    shippingPrice: number;
    quantity: number;
    listingType: string;
    customTitle: string | null;
    sellerName: string | null;
    sellerRating: number | null;
    sellerSales: string | null;
    directSeller: boolean;
  }[] = [];

  let fetched = 0;
  let failed = 0;
  let skippedIncomparable = 0;

  for (const batch of chunk(watched, CONCURRENCY)) {
    await Promise.all(
      batch.map(async (p) => {
        try {
          const listings = await fetchListings(p.productId, { size: 25 });
          // Filter to what can legitimately be compared with our Near Mint
          // English benchmark BEFORE storing — a Damaged or Chinese listing is
          // not a deal candidate, it's a different product.
          const comparable = listings.filter((l) => {
            const ok = isComparableListing({
              condition: l.condition,
              language: l.language,
              printing: l.printing,
              price: l.price,
              listingType: l.listingType,
              customTitle: l.customData?.title ?? null,
            });
            if (!ok) skippedIncomparable++;
            return ok;
          });

          for (const l of comparable.slice(0, KEEP_PER_PRODUCT)) {
            rows.push({
              listingId: BigInt(l.listingId),
              productId: p.productId,
              finish: l.printing || "Normal",
              condition: l.condition,
              language: l.language,
              price: l.price,
              shippingPrice: l.shippingPrice ?? 0,
              quantity: l.quantity ?? 1,
              listingType: l.listingType ?? "standard",
              customTitle: l.customData?.title ?? null,
              sellerName: l.sellerName ?? null,
              sellerRating: l.sellerRating ?? null,
              sellerSales: l.sellerSales ?? null,
              directSeller: Boolean(l.directSeller),
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
          if (fetched % 200 === 0) console.log(`  polled ${fetched}/${watched.length}`);
        }
      }),
    );
    if (BATCH_PAUSE_MS) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
  }

  const pollMs = Date.now() - started;
  console.log(
    `Polled ${fetched} in ${(pollMs / 1000).toFixed(1)}s — ${rows.length} comparable listings, ` +
      `${skippedIncomparable} skipped (damaged/played/non-English), ${failed} failed.`,
  );

  if (fetched > 0 && failed === fetched) {
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, note: `all ${failed} requests failed` },
    });
    console.error("FAILED: every request errored — upstream blocked or offline.");
    process.exit(1);
  }

  // Replace wholesale: a listing that sold must vanish, not linger as a phantom
  // deal. Scoped to the products we actually polled so a --limit run can't wipe
  // listings it never refreshed.
  const polledIds = watched.map((w) => w.productId);
  await prisma.listing.deleteMany({ where: { productId: { in: polledIds } } });

  const unique = new Map(rows.map((r) => [r.listingId.toString(), r]));
  let inserted = 0;
  for (const batch of chunk([...unique.values()], 500)) {
    const res = await prisma.listing.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
  }

  await prisma.ingestRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      productCount: fetched,
      priceRowCount: inserted,
      ok: true,
      note: `${inserted} listings, ${failed} failed, ${(pollMs / 1000).toFixed(0)}s`,
    },
  });

  console.log(`Stored ${inserted} listing(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
