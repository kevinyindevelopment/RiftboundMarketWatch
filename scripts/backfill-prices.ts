// Backfill historical daily prices from the tcgcsv archive.
//
//   npm run backfill -- --from 2025-07-30 --to 2026-08-12
//   npm run backfill -- --from 2026-08-01            (…to yesterday)
//
// Why this exists: tcgcsv's live `/prices` endpoint is TODAY ONLY. Without a
// backfill, a brand-new deployment starts with a single day of data and the
// movers board stays empty for a week. The archive goes back to 2024-02-08,
// which comfortably predates Riftbound's first set.
//
// REQUIREMENTS
//   - `7z` on PATH. The archives use PPMd compression, which Node's zlib cannot
//     read, so extraction shells out. GitHub's ubuntu-latest runners ship 7z
//     preinstalled; locally, `sudo apt install p7zip-full`.
//   - Products must already be ingested (`npm run ingest`) — price rows are
//     FK'd to Product, and any price for an unknown product is skipped.
//
// Each daily archive is ~4 MB and covers EVERY TCGplayer category, of which we
// extract only category 89. One day at a time, sequentially: this is a one-shot
// catch-up job, and hammering a free community mirror to save a few minutes
// would be rude.

import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RIFTBOUND_CATEGORY_ID } from "../src/lib/tcgcsv";
import { prisma } from "../src/lib/prisma";

const execFileAsync = promisify(execFile);

const CACHE = resolve(".backfill-cache");
const ARCHIVE_BASE = "https://tcgcsv.com/archive/tcgplayer";

/**
 * The archive host rejects requests with NO User-Agent header with a bare
 * `401 Unauthorized` — which reads exactly like "this endpoint needs auth" and
 * sent an earlier debugging pass chasing a nonexistent IP block. Node's `fetch`
 * sends no UA by default (PowerShell/curl do, which is why the same URL appeared
 * to work by hand and fail from the script).
 *
 * Any non-empty value is accepted; verified against none/curl/browser/this one.
 * Do not remove.
 */
const UA =
  "RiftboundMarketWatch/0.1 (+https://github.com/kevinyindevelopment/RiftboundMarketWatch)";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = get("--from");
  if (!from) {
    console.error("Usage: npm run backfill -- --from YYYY-MM-DD [--to YYYY-MM-DD]");
    process.exit(1);
  }
  // Default end is YESTERDAY: today's archive isn't published until ~20:00 UTC,
  // and today's prices come from the normal ingest anyway.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return { from, to: get("--to") ?? yesterday };
}

/** Inclusive list of YYYY-MM-DD strings. */
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Locate a 7-Zip binary, probing the names different packages install under
 * (p7zip-full ships `7z`, p7zip-lite `7za`, the official build `7zz`).
 * Resolved once and cached — this is called per day otherwise.
 */
let cachedBin: string | null | undefined;
async function sevenZipBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  for (const bin of ["7z", "7za", "7zz"]) {
    try {
      await execFileAsync(bin, ["i"]);
      cachedBin = bin;
      return bin;
    } catch {
      /* try the next name */
    }
  }
  cachedBin = null;
  return null;
}

/** Download + extract one day, returning that day's category-89 price rows. */
async function fetchArchiveDay(day: string) {
  const url = `${ARCHIVE_BASE}/prices-${day}.ppmd.7z`;
  const archivePath = join(CACHE, `${day}.7z`);
  const outDir = join(CACHE, day);

  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (res.status === 404) return null; // upstream simply has no file for that day
  if (!res.ok) throw new Error(`archive ${res.status} ${res.statusText} for ${url}`);
  writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

  // Extract ONLY our category. The archive holds every TCGplayer category, and
  // unpacking all of them costs ~40x the disk and time for data we never read.
  const bin = (await sevenZipBin())!; // presence checked up front in main()
  await execFileAsync(bin, [
    "x",
    archivePath,
    `-o${outDir}`,
    `${day}/${RIFTBOUND_CATEGORY_ID}/*`,
    "-r",
    "-y",
  ]);

  const categoryDir = join(outDir, day, String(RIFTBOUND_CATEGORY_ID));
  if (!existsSync(categoryDir)) return []; // category didn't exist yet that day

  const rows: {
    productId: number;
    subTypeName: string;
    lowPrice: number | null;
    midPrice: number | null;
    highPrice: number | null;
    marketPrice: number | null;
    directLowPrice: number | null;
  }[] = [];

  for (const groupId of await readdir(categoryDir)) {
    const file = join(categoryDir, groupId, "prices");
    if (!existsSync(file)) continue;
    const body = JSON.parse(readFileSync(file, "utf8")) as {
      results?: typeof rows;
    };
    for (const r of body.results ?? []) {
      rows.push({
        productId: r.productId,
        subTypeName: r.subTypeName,
        lowPrice: r.lowPrice,
        midPrice: r.midPrice,
        highPrice: r.highPrice,
        marketPrice: r.marketPrice,
        directLowPrice: r.directLowPrice,
      });
    }
  }
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.DIRECT_DATABASE_URL) {
    console.error("No DATABASE_URL / DIRECT_DATABASE_URL set — see .env.example.");
    process.exit(1);
  }
  if (!(await sevenZipBin())) {
    console.error(
      "`7z` not found on PATH. The tcgcsv archives use PPMd compression, which\n" +
        "Node cannot decompress natively.\n" +
        "  Ubuntu/WSL: sudo apt install p7zip-full\n" +
        "  Windows:    winget install 7zip.7zip\n" +
        "  GitHub Actions: already installed on ubuntu-latest.",
    );
    process.exit(1);
  }

  const { from, to } = parseArgs();
  const days = dateRange(from, to);
  console.log(`Backfilling ${days.length} day(s): ${from} → ${to}`);

  mkdirSync(CACHE, { recursive: true });

  // Products are the FK target; anything not currently listed gets skipped.
  const knownProductIds = new Set(
    (await prisma.product.findMany({ select: { productId: true } })).map(
      (p) => p.productId,
    ),
  );
  if (knownProductIds.size === 0) {
    console.error("No products in the DB — run `npm run ingest` first.");
    process.exit(1);
  }

  // Skip days already present, so an interrupted backfill can just be re-run.
  const existing = new Set(
    (
      await prisma.priceSnapshot.findMany({
        distinct: ["date"],
        select: { date: true },
      })
    ).map((r) => r.date.toISOString().slice(0, 10)),
  );

  let written = 0;
  let skipped = 0;
  let failed = 0;
  let rowsTotal = 0;
  for (const day of days) {
    if (existing.has(day)) {
      skipped++;
      continue;
    }
    try {
      const rows = await fetchArchiveDay(day);
      if (rows === null) {
        console.log(`  ${day}  (no archive published)`);
        continue;
      }
      const usable = rows
        .filter((r) => knownProductIds.has(r.productId))
        .map((r) => ({ ...r, date: new Date(`${day}T00:00:00.000Z`) }));

      if (usable.length > 0) {
        await prisma.priceSnapshot.createMany({
          data: usable,
          skipDuplicates: true,
        });
        await prisma.ingestRun.create({
          data: {
            date: new Date(`${day}T00:00:00.000Z`),
            finishedAt: new Date(),
            priceRowCount: usable.length,
            source: "backfill",
            ok: true,
          },
        });
      }
      written++;
      rowsTotal += usable.length;
      console.log(
        `  ${day}  ${usable.length} rows (${rows.length - usable.length} unknown products skipped)`,
      );
    } catch (err) {
      // One bad day shouldn't abort a 380-day catch-up.
      failed++;
      console.warn(`  ${day}  FAILED: ${err instanceof Error ? err.message : err}`);
    } finally {
      rmSync(join(CACHE, day), { recursive: true, force: true });
      rmSync(join(CACHE, `${day}.7z`), { force: true });
    }
  }

  console.log(
    `\nDone: ${written} day(s) written (${rowsTotal} rows), ` +
      `${skipped} already present, ${failed} failed.`,
  );

  // Exit non-zero when the run accomplished nothing but had work to do.
  // The first CI attempt failed EVERY day (missing User-Agent -> 401) yet still
  // exited 0, so the workflow reported success while writing nothing. A green
  // check that means "silently did nothing" is worse than no check at all.
  const attempted = days.length - skipped;
  if (attempted > 0 && written === 0) {
    console.error(
      `\nFAILED: ${attempted} day(s) attempted, none written (${failed} errored).`,
    );
    process.exit(1);
  }
  // Partial failure is worth surfacing too, without discarding what landed.
  if (failed > 0) {
    console.warn(`\nWARNING: ${failed} day(s) failed; re-run to retry just those.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
