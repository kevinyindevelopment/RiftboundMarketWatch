// Expected value of a sealed booster box, from our own price data.
//
// The whole page rests on two things that are NOT obvious from the schema, so
// they are encoded here once rather than re-derived at each call site:
//
// 1. WHICH PRINTING A CARD IS, from its TCGplayer name suffix — not from the
//    Riftcodex `isAlternateArt` / `isSignature` / `isOvernumbered` flags. Those
//    flags lag each new set by weeks (see AGENTS.md) and are wrong in ways that
//    silently wreck an average: measured on 2026-08-13, every Signature card in
//    the database had `isOvernumbered = false` despite being numbered 306*/298,
//    and Vendetta had 43 Showcase cards with no flags set at all. Classifying on
//    the suffix TCGplayer itself writes — "(Signature)", "(Overnumbered)",
//    "(Alternate Art)" — partitions all four booster sets exactly, with zero
//    leftovers, and works the day a set is listed.
//
// 2. RARE AND ABOVE ONLY EXIST AS FOIL. Riftbound prints every Rare, Epic and
//    Showcase card foil, so TCGplayer lists them under `subTypeName = "Foil"`
//    and there is no Normal row at all (verified: 0 Normal price rows for Rare/
//    Epic/Showcase across OGN/SFD/UNL/VEN, vs a full set of Foil rows). Only
//    Common and Uncommon have both finishes. Reading the "Normal" price for a
//    Rare therefore returns null, not a cheaper number — a bug that would zero
//    out most of a box's value. See `cardPrice()`.

import { HIGH_RARITIES, MIN_WATCH_VALUE } from "./deals";

/** How a printing was produced — drives which box slot the card can come from. */
export type Printing =
  | "base"
  | "alt-art"
  | "overnumbered"
  | "signature"
  | "rune"
  | "other";

/** The parenthetical TCGplayer appends to a card's name, or "" if there is none. */
function nameSuffix(name: string): string {
  const m = name.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : "";
}

/**
 * Classify a card by its TCGplayer name, not by the Riftcodex flags.
 *
 * "other" is deliberate rather than a fallback bucket to ignore: it collects
 * things we have no published pull rate for (Vendetta's SP#/006 subset, the
 * Unleashed "Baron Nashor (Ultimate)"), and the page lists them so their absence
 * from the EV is visible instead of silent.
 */
export function classifyPrinting(
  name: string,
  rarity: string | null,
  number?: string | null,
): Printing {
  const suffix = nameSuffix(name);
  if (/^R\d\d[ab]$/.test(suffix)) return "rune";
  if (suffix === "Alternate Art") return "alt-art";
  if (suffix === "Overnumbered") return "overnumbered";
  if (suffix === "Signature") return "signature";

  // Vendetta's Crystal Rose cards (SP1/006 … SP6/006) are alternate arts and
  // come out of the same alternate-art slot, but TCGplayer gives them no
  // "(Alternate Art)" suffix — the collector number is the only thing that
  // identifies them. Missing this dropped six cards worth $18-$99 out of the
  // Vendetta EV entirely.
  if (/^SP\d+\//i.test(number ?? "")) return "alt-art";

  // Any other Showcase with no recognised suffix is a subset we have no pull
  // rate for, not a pack pull.
  if (suffix === "" && rarity === "Showcase") return "other";
  if (suffix !== "") return "other";
  return "base";
}

/**
 * Is this card worth counting toward a box's value?
 *
 * The rule: a card counts if it is **Epic or better, or worth $1 or more**.
 * Everything else is bulk and contributes nothing. This is deliberately the same
 * bar the deals watch list uses, imported rather than restated so the two pages
 * can never drift into disagreeing about what a "relevant card" is.
 *
 * Note what the rule does NOT mean — a $0.31 Epic still counts at $0.31; it is
 * not dropped from the pool. Dropping it would lift Spiritforged's Epic average
 * from $6.40 to $10.30 and inflate every box on the page, because you really can
 * open a bulk Epic and the odds have to account for it.
 */
export function isRelevant(rarity: string | null, printing: Printing, price: number | null): boolean {
  // Alt art / overnumbered / signature are Showcase printings by construction,
  // so they clear the bar whatever TCGplayer happens to have set `rarity` to —
  // Vendetta lists two alternate arts as Epic and Rare.
  if (printing === "alt-art" || printing === "overnumbered" || printing === "signature") return true;
  if (rarity != null && HIGH_RARITIES.has(rarity)) return true;
  return price != null && price >= MIN_WATCH_VALUE;
}

/** A card as the EV maths needs it: one price per finish, plus its printing. */
export type BoxCard = {
  productId: number;
  name: string;
  rarity: string | null;
  number: string | null;
  printing: Printing;
  /** Sales-derived if we have enough recent sales, else TCGplayer market price. */
  normalPrice: number | null;
  foilPrice: number | null;
  /** Whether the shown price came from real sales — surfaced as coverage. */
  normalFromSales: boolean;
  foilFromSales: boolean;
  tcgplayerUrl: string;
};

/**
 * The price that describes this card as you'd pull it from a pack.
 *
 * Rare and above have no Normal printing at all, so the foil price IS the price;
 * for Common/Uncommon the Normal price is the base card and the foil is the
 * separate 1-per-pack slot.
 */
export function cardPrice(card: BoxCard, finish: "base" | "foil"): number | null {
  return cardPriceWithSource(card, finish).price;
}

/**
 * The price, plus whether anyone actually paid it.
 *
 * The flag has to travel with the number through the same fallback, or a Rare's
 * price would be read from the foil column while its "is this real" flag was
 * read from the empty Normal one.
 */
export function cardPriceWithSource(
  card: BoxCard,
  finish: "base" | "foil",
): { price: number | null; fromSales: boolean } {
  if (finish === "foil") return { price: card.foilPrice, fromSales: card.foilFromSales };
  if (card.normalPrice != null) {
    return { price: card.normalPrice, fromSales: card.normalFromSales };
  }
  return { price: card.foilPrice, fromSales: card.foilFromSales };
}

/**
 * A slot's candidate pool, reduced to the only two numbers the EV needs.
 *
 * `n` is the FULL pool including bulk and unpriced cards — it is the denominator
 * because a pull always produces something. `relevantSum` adds up only what
 * `isRelevant` lets through. So `relevantSum / n` is the expected value of one
 * pull from this slot, with bulk correctly contributing zero rather than being
 * quietly excluded from the odds.
 */
export type Pool = {
  n: number;
  /** How many of `n` we have any price for — coverage, not a denominator. */
  priced: number;
  /** How many of `n` clear the relevance bar. */
  relevantN: number;
  /**
   * Value that someone has actually paid recently. ONLY sales-derived prices
   * land here — see `buildPool`.
   */
  relevantSum: number;
  /** Relevant cards whose only price is a TCGplayer market estimate. */
  unverifiedN: number;
  /** What those cards would have added, had we counted them. */
  unverifiedSum: number;
};

export const EMPTY_POOL: Pool = {
  n: 0,
  priced: 0,
  relevantN: 0,
  relevantSum: 0,
  unverifiedN: 0,
  unverifiedSum: 0,
};

/**
 * Reduce a slot's candidate cards to the numbers the EV needs.
 *
 * ONLY SALES-DERIVED PRICES COUNT AS VALUE. A card priced from TCGplayer's
 * market estimate is carried in `unverifiedSum` and contributes nothing, because
 * an EV is what you can expect to *realise*, and an estimate nobody has paid is
 * not evidence you can realise it.
 *
 * This is not a theoretical worry — it was measured, and it was the single
 * biggest error on this page. Every foil Common/Uncommon that TCGplayer values
 * over $1 has zero recorded sales: Origins alone claimed $132.77 of them
 * (Stacked Deck "$18.68", Pack of Wonders "$11.78", Defy "$9.33"), worth $18.42
 * a box. Where a foil Common/Uncommon actually *does* sell — and there are 597
 * such sales on record across the four sets — it goes for $0.06 to $0.90. Not
 * one sales-verified foil Common or Uncommon in Origins, Spiritforged or
 * Unleashed clears $1. The estimates weren't approximately right; they were
 * contradicted by every real sale of the same kind of card.
 *
 * The high-value slots are unaffected — Rare, Epic, alternate art and
 * overnumbered are 100% sales-derived in all four sets — so this costs almost
 * nothing that was real.
 */
export function buildPool(cards: BoxCard[], finish: "base" | "foil"): Pool {
  let priced = 0;
  let relevantN = 0;
  let relevantSum = 0;
  let unverifiedN = 0;
  let unverifiedSum = 0;
  for (const c of cards) {
    const { price, fromSales } = cardPriceWithSource(c, finish);
    if (price != null) priced++;
    if (!isRelevant(c.rarity, c.printing, price)) continue;
    relevantN++;
    if (price == null) continue;
    if (fromSales) {
      relevantSum += price;
    } else {
      unverifiedN++;
      unverifiedSum += price;
    }
  }
  return { n: cards.length, priced, relevantN, relevantSum, unverifiedN, unverifiedSum };
}

/** Expected value of a single pull from a pool. */
export function perPull(pool: Pool): number {
  return pool.n === 0 ? 0 : pool.relevantSum / pool.n;
}

/** Merge pools that feed one slot (e.g. the foil slot spans several rarities). */
export function mergePools(...pools: Pool[]): Pool {
  return pools.reduce(
    (a, p) => ({
      n: a.n + p.n,
      priced: a.priced + p.priced,
      relevantN: a.relevantN + p.relevantN,
      relevantSum: a.relevantSum + p.relevantSum,
      unverifiedN: a.unverifiedN + p.unverifiedN,
      unverifiedSum: a.unverifiedSum + p.unverifiedSum,
    }),
    EMPTY_POOL,
  );
}

/** Every pool a box draws from. Keys are the slot names used in the UI. */
export type BoxPools = {
  common: Pool;
  uncommon: Pool;
  rare: Pool;
  epic: Pool;
  altArt: Pool;
  overnumbered: Pool;
  signature: Pool;
  foilCommon: Pool;
  foilUncommon: Pool;
};

/** The pull rates a box is opened against. See `BOX_ASSUMPTIONS`. */
export type BoxAssumptions = {
  packsPerBox: number;
  commonsPerPack: number;
  uncommonsPerPack: number;
  rarePlusPerPack: number;
  foilsPerPack: number;
  /** Guaranteed Epics per box (worst case). Consumes rare-or-better slots. */
  epicsPerBox: number;
  /** Guaranteed alternate arts per box (worst case). */
  altArtsPerBox: number;
  /** One overnumbered card every N boxes. */
  boxesPerOvernumbered: number;
  /** Fraction of overnumbered pulls that are Signature instead. */
  signatureShareOfOvernumbered: number;
  /**
   * Which cards the 1-per-pack foil slot can be.
   *
   * "common-uncommon" is the worst case and the default: Rare and above are
   * already foil, so a foil slot that rolled one would be the same product the
   * rare-or-better slots already pay for, and counting it again double-counts.
   */
  foilSlotPool: "common-uncommon" | "all-rarities";
};

/**
 * The pull rates, as known — not guesses to be tuned.
 *
 * Worst-case guarantees per box: 6 Epics, 2 alternate arts, and one
 * overnumbered every 3 boxes of which a tenth are Signature. Pack contents are
 * the published 7 common / 3 uncommon / 2 rare-or-better / 1 foil, and a
 * booster display is 24 packs.
 *
 * Still a parameter of `computeBoxEv` rather than a hardcoded read, so the maths
 * can be tested against pools with known answers.
 */
export const BOX_ASSUMPTIONS: BoxAssumptions = {
  packsPerBox: 24,
  commonsPerPack: 7,
  uncommonsPerPack: 3,
  rarePlusPerPack: 2,
  foilsPerPack: 1,
  epicsPerBox: 6,
  altArtsPerBox: 2,
  boxesPerOvernumbered: 3,
  signatureShareOfOvernumbered: 0.1,
  foilSlotPool: "common-uncommon",
};

export type EvLine = {
  slot: string;
  /** Expected number of pulls from this slot per box. */
  pulls: number;
  /** Expected value of ONE pull from it. */
  perPull: number;
  value: number;
  pool: Pool;
  note?: string;
};

export type BoxEv = {
  lines: EvLine[];
  total: number;
  /**
   * EV of a box that does NOT hit the overnumbered slot — which is most of them.
   * The headline EV is an average over a rare, very large payout, so quoting it
   * alone tells you what a box is worth on average and nothing about what a box
   * is usually worth.
   */
  withoutJackpot: number;
  /** Share of total EV that comes from the overnumbered/signature slot. */
  jackpotShare: number;
};

export function computeBoxEv(pools: BoxPools, a: BoxAssumptions = BOX_ASSUMPTIONS): BoxEv {
  const rarePlusSlots = a.packsPerBox * a.rarePlusPerPack;
  const overnumberedPerBox = a.boxesPerOvernumbered > 0 ? 1 / a.boxesPerOvernumbered : 0;

  // The Epic / alt-art / overnumbered guarantees are not extra cards — they
  // occupy rare-or-better slots. Whatever is left over is filled with Rares.
  const guaranteed = a.epicsPerBox + a.altArtsPerBox + overnumberedPerBox;
  const rareSlots = Math.max(0, rarePlusSlots - guaranteed);

  const foilPool =
    a.foilSlotPool === "all-rarities"
      ? mergePools(pools.foilCommon, pools.foilUncommon, pools.rare, pools.epic)
      : mergePools(pools.foilCommon, pools.foilUncommon);

  // Split the overnumbered slot into its ordinary and Signature halves so the
  // page can show where a four-figure number is coming from.
  const sigShare = a.signatureShareOfOvernumbered;
  const ordinaryOvPulls = overnumberedPerBox * (1 - sigShare);
  const signaturePulls = overnumberedPerBox * sigShare;

  const line = (slot: string, pulls: number, pool: Pool, note?: string): EvLine => ({
    slot,
    pulls,
    perPull: perPull(pool),
    value: pulls * perPull(pool),
    pool,
    note,
  });

  const lines: EvLine[] = [
    line("Signature", signaturePulls, pools.signature, `${(sigShare * 100).toFixed(0)}% of overnumbered pulls`),
    line("Overnumbered", ordinaryOvPulls, pools.overnumbered, `1 per ${a.boxesPerOvernumbered} boxes`),
    line("Epic", a.epicsPerBox, pools.epic),
    line("Alternate art", a.altArtsPerBox, pools.altArt),
    line("Rare", rareSlots, pools.rare, "remaining rare-or-better slots"),
    line("Foil", a.packsPerBox * a.foilsPerPack, foilPool),
    line("Uncommon", a.packsPerBox * a.uncommonsPerPack, pools.uncommon),
    line("Common", a.packsPerBox * a.commonsPerPack, pools.common),
  ];

  const total = lines.reduce((sum, l) => sum + l.value, 0);
  const jackpot =
    lines.find((l) => l.slot === "Signature")!.value +
    lines.find((l) => l.slot === "Overnumbered")!.value;

  return {
    lines,
    total,
    withoutJackpot: total - jackpot,
    jackpotShare: total > 0 ? jackpot / total : 0,
  };
}
