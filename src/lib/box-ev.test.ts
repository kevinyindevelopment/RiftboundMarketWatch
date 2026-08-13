import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOX_ASSUMPTIONS,
  buildPool,
  cardPrice,
  classifyPrinting,
  computeBoxEv,
  isRelevant,
  mergePools,
  perPull,
  type BoxCard,
  type BoxPools,
} from "./box-ev";

function card(over: Partial<BoxCard>): BoxCard {
  return {
    productId: 1,
    name: "Card",
    rarity: "Rare",
    number: "1/100",
    printing: "base",
    normalPrice: null,
    foilPrice: null,
    // Sales-derived by default: only prices someone actually paid count as
    // value, so a card built without saying otherwise should count.
    normalFromSales: true,
    foilFromSales: true,
    tcgplayerUrl: "https://example.test",
    ...over,
  };
}

test("classifies printings from the TCGplayer name suffix", () => {
  assert.equal(classifyPrinting("Ahri, Nine-Tailed Fox", "Rare"), "base");
  assert.equal(classifyPrinting("Akali - Deadly Weapon (Alternate Art)", "Showcase"), "alt-art");
  assert.equal(classifyPrinting("Teemo, Swift Scout (Overnumbered)", "Showcase"), "overnumbered");
  assert.equal(classifyPrinting("Leona, Radiant Dawn (Signature)", "Showcase"), "signature");
  assert.equal(classifyPrinting("Chaos Rune (R05a)", "Showcase"), "rune");
});

// The flags in the database say these are ordinary cards; the name says
// otherwise and the name is what we trust. Getting this wrong drops four-figure
// signatures into the alt-art pool.
test("a Signature is classified from its name even though isOvernumbered is false", () => {
  assert.equal(classifyPrinting("Yasuo, Unforgiven (Signature)", "Showcase"), "signature");
});

// Crystal Rose carries no "(Alternate Art)" suffix, so only the collector
// number identifies it. Six Vendetta cards worth $18-$99 hung on this.
test("Vendetta's Crystal Rose subset is alternate art, found by collector number", () => {
  assert.equal(classifyPrinting("Sett, Brawler", "Showcase", "SP4/006"), "alt-art");
  assert.equal(classifyPrinting("Ahri, Inquisitive", "Showcase", "SP3/006"), "alt-art");
});

test("Showcase cards with no recognised suffix are excluded, not guessed at", () => {
  assert.equal(classifyPrinting("Sett, Brawler", "Showcase", "004/166"), "other");
  assert.equal(classifyPrinting("Baron Nashor (Ultimate)", "Showcase", "238/219"), "other");
});

test("relevance is Epic-or-better OR $1+", () => {
  assert.equal(isRelevant("Epic", "base", 0.31), true, "a cheap Epic still counts");
  assert.equal(isRelevant("Rare", "base", 0.34), false, "a bulk Rare does not");
  assert.equal(isRelevant("Rare", "base", 1), true, "$1 exactly is 'worth $1 or more'");
  assert.equal(isRelevant("Common", "base", 4.82), true);
  assert.equal(isRelevant("Common", "base", null), false, "no price is not evidence of value");
  // Vendetta really does list an alternate art at Rare rarity.
  assert.equal(isRelevant("Rare", "alt-art", 1.24), true);
});

test("a Rare's price is its foil price, because Rares have no Normal printing", () => {
  const rare = card({ rarity: "Rare", normalPrice: null, foilPrice: 28.92 });
  assert.equal(cardPrice(rare, "base"), 28.92);
  assert.equal(cardPrice(rare, "foil"), 28.92);

  // A Common has both, and they are genuinely different products.
  const common = card({ rarity: "Common", normalPrice: 4.82, foilPrice: 9.33 });
  assert.equal(cardPrice(common, "base"), 4.82);
  assert.equal(cardPrice(common, "foil"), 9.33);
});

test("bulk stays in the denominator instead of being dropped", () => {
  const pool = buildPool(
    [
      card({ rarity: "Rare", foilPrice: 30 }),
      card({ rarity: "Rare", foilPrice: 0.2 }),
      card({ rarity: "Rare", foilPrice: 0.2 }),
      card({ rarity: "Rare", foilPrice: 0.2 }),
    ],
    "foil",
  );
  assert.deepEqual(pool, {
    n: 4,
    priced: 4,
    relevantN: 1,
    relevantSum: 30,
    unverifiedN: 0,
    unverifiedSum: 0,
  });
  // 30/4, not 30/1 â€” you have to open the three bulk Rares to get the good one.
  assert.equal(perPull(pool), 7.5);
});

// The bug this page shipped with: TCGplayer valued foil commons at $9-$18 with
// zero sales behind them, while every foil common that HAS sold went for under
// $1. An estimate nobody has paid is not value you can realise.
test("a market estimate contributes nothing, and is reported separately", () => {
  const pool = buildPool(
    [
      card({ rarity: "Common", foilPrice: 18.68, foilFromSales: false }),
      card({ rarity: "Common", foilPrice: 9.33, foilFromSales: false }),
      card({ rarity: "Common", foilPrice: 0.28, foilFromSales: true }),
    ],
    "foil",
  );
  assert.equal(pool.relevantSum, 0, "no sales-verified card clears $1");
  assert.equal(pool.relevantN, 2, "both estimates are still relevant enough to list");
  assert.equal(pool.unverifiedN, 2);
  assert.ok(Math.abs(pool.unverifiedSum - 28.01) < 1e-9);
  assert.equal(perPull(pool), 0);
});

test("the sales flag follows the same fallback as the price", () => {
  // A Rare has no Normal printing: the base price comes from the foil column, so
  // the foil column's flag is the one that must be consulted.
  const rare = card({
    rarity: "Rare",
    normalPrice: null,
    normalFromSales: true,
    foilPrice: 28.92,
    foilFromSales: false,
  });
  assert.equal(buildPool([rare], "base").relevantSum, 0);
  assert.equal(buildPool([rare], "base").unverifiedSum, 28.92);
});

test("unpriced cards count as $0 but still occupy the pool", () => {
  const pool = buildPool(
    [card({ rarity: "Epic", foilPrice: 10 }), card({ rarity: "Epic", foilPrice: null })],
    "foil",
  );
  assert.equal(pool.n, 2);
  assert.equal(pool.priced, 1);
  assert.equal(pool.relevantN, 2, "an Epic is relevant whether or not we have a price");
  assert.equal(perPull(pool), 5);
});

test("perPull of an empty pool is 0, not NaN", () => {
  assert.equal(perPull(buildPool([], "foil")), 0);
});

test("mergePools sums pools that feed one slot", () => {
  const a = { n: 2, priced: 2, relevantN: 1, relevantSum: 5, unverifiedN: 1, unverifiedSum: 2 };
  const b = { n: 3, priced: 1, relevantN: 2, relevantSum: 7, unverifiedN: 0, unverifiedSum: 0 };
  assert.deepEqual(mergePools(a, b), {
    n: 5,
    priced: 3,
    relevantN: 3,
    relevantSum: 12,
    unverifiedN: 1,
    unverifiedSum: 2,
  });
});

/** Pools where one pull from every slot is worth exactly $1. */
function unitPools(): BoxPools {
  const unit = { n: 1, priced: 1, relevantN: 1, relevantSum: 1, unverifiedN: 0, unverifiedSum: 0 };
  return {
    common: unit,
    uncommon: unit,
    rare: unit,
    epic: unit,
    altArt: unit,
    overnumbered: unit,
    signature: unit,
    foilCommon: unit,
    foilUncommon: unit,
  };
}

test("guaranteed pulls come out of the rare-or-better slots, not on top of them", () => {
  const ev = computeBoxEv(unitPools(), BOX_ASSUMPTIONS);
  const pulls = (slot: string) => ev.lines.find((l) => l.slot === slot)!.pulls;

  const rarePlusSlots = BOX_ASSUMPTIONS.packsPerBox * BOX_ASSUMPTIONS.rarePlusPerPack;
  const consumed =
    pulls("Epic") + pulls("Alternate art") + pulls("Overnumbered") + pulls("Signature");
  assert.equal(pulls("Rare") + consumed, rarePlusSlots);
  assert.equal(pulls("Rare"), 48 - 6 - 2 - 1 / 3);
});

test("the overnumbered slot splits into ordinary and Signature by the given share", () => {
  const ev = computeBoxEv(unitPools(), BOX_ASSUMPTIONS);
  const sig = ev.lines.find((l) => l.slot === "Signature")!;
  const ov = ev.lines.find((l) => l.slot === "Overnumbered")!;
  // 1 overnumbered every 3 boxes, 10% of them Signature.
  assert.ok(Math.abs(sig.pulls - (1 / 3) * 0.1) < 1e-12);
  assert.ok(Math.abs(ov.pulls - (1 / 3) * 0.9) < 1e-12);
  assert.ok(Math.abs(sig.pulls + ov.pulls - 1 / 3) < 1e-12);
});

test("more guaranteed hits than slots clamps the Rare count at zero", () => {
  const ev = computeBoxEv(unitPools(), { ...BOX_ASSUMPTIONS, epicsPerBox: 500 });
  assert.equal(ev.lines.find((l) => l.slot === "Rare")!.pulls, 0);
});

test("the jackpot figure isolates the overnumbered slot", () => {
  const pools = unitPools();
  // A Signature pool worth $1,000 a pull, everything else $1.
  pools.signature = { n: 1, priced: 1, relevantN: 1, relevantSum: 1000, unverifiedN: 0, unverifiedSum: 0 };
  const ev = computeBoxEv(pools, BOX_ASSUMPTIONS);
  const jackpot =
    ev.lines.find((l) => l.slot === "Signature")!.value +
    ev.lines.find((l) => l.slot === "Overnumbered")!.value;

  assert.ok(Math.abs(ev.total - ev.withoutJackpot - jackpot) < 1e-9);
  assert.ok(Math.abs(ev.jackpotShare - jackpot / ev.total) < 1e-12);
});

test("the foil slot excludes Rare+ by default and includes it when asked", () => {
  const pools = unitPools();
  pools.rare = { n: 1, priced: 1, relevantN: 1, relevantSum: 100, unverifiedN: 0, unverifiedSum: 0 };
  pools.epic = { n: 1, priced: 1, relevantN: 1, relevantSum: 100, unverifiedN: 0, unverifiedSum: 0 };

  const strict = computeBoxEv(pools, BOX_ASSUMPTIONS).lines.find((l) => l.slot === "Foil")!;
  // Only foilCommon + foilUncommon: two $1 cards, so $1 a pull.
  assert.equal(strict.perPull, 1);

  const generous = computeBoxEv(pools, {
    ...BOX_ASSUMPTIONS,
    foilSlotPool: "all-rarities",
  }).lines.find((l) => l.slot === "Foil")!;
  // (1 + 1 + 100 + 100) / 4
  assert.equal(generous.perPull, 50.5);
});

test("total is the sum of the lines", () => {
  const ev = computeBoxEv(unitPools(), BOX_ASSUMPTIONS);
  const sum = ev.lines.reduce((a, l) => a + l.value, 0);
  assert.ok(Math.abs(ev.total - sum) < 1e-9);
});

