// Dump the full card + price dataset to JSON — no database, no credentials.
//
//   npx tsx scripts/snapshot.ts [outfile]
//
// This is the "just give me the data" path, and it's also how you sanity-check
// upstream before pointing an ingest at the real DB: it runs the exact same
// collect() the Postgres ingest runs.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectAll } from "../src/lib/collect";

async function main() {
  const out = resolve(process.argv[2] ?? "data/riftbound-market-snapshot.json");

  const data = await collectAll((msg) => console.log(msg));

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data, null, 2), "utf8");

  const s = data.stats;
  console.log("");
  console.log(`Snapshot ${data.date} written to ${out}`);
  console.log(`  sets                 ${s.sets}`);
  console.log(`  products             ${s.products}  (${s.singles} singles, ${s.sealed} sealed)`);
  console.log(`  price rows           ${s.priceRows}  (${s.productsWithPrice} distinct products priced)`);
  console.log(`  riftcodex cards      ${s.riftcodexCards}`);
  console.log(
    `  joined to riftcodex  ${s.matchedToRiftcodex}` +
      `  (${s.matchedByTcgplayerId} by tcgplayer_id, ${s.matchedByRiftboundId} by riftbound_id)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
