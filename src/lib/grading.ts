// Card *variants* — the distinctions that make two listings of "the same card"
// different products with different prices.
//
// There are two independent axes, and conflating them is the classic way to
// produce a nonsense average:
//
//   PRINTING  — which physical printing it is (base / alternate art /
//               overnumbered / signature / overnumbered signature). Fixed at
//               manufacture; already modelled on `Product`.
//   GRADE     — how it was slabbed, if at all (raw, PSA 10, BGS 10, …). Applied
//               after the fact; the SAME printing exists in many grades at
//               wildly different prices.
//
// A price is only meaningful for a (printing, grade) pair. A PSA 10 signature
// and a raw signature are not the same market.
//
// GRADING SCALE NOTES (these trip people up):
//   - BGS 10 IS "Pristine" — that's simply what BGS calls a 10. So "BGS 10" and
//     "BGS 10 Pristine" are the SAME grade, not two.
//   - BGS 10 **Black Label** is the distinct, much rarer one: a 10 where all
//     four subgrades are also 10. Materially more valuable.
//   - CGC is the opposite shape: CGC 10 is "Gem Mint", and CGC **Pristine 10**
//     is a separate, higher designation. So for CGC, 10 and Pristine 10 ARE
//     different — unlike BGS.

/** Grading companies we distinguish. */
export type Grader = "PSA" | "BGS" | "CGC" | "SGC";

export type GradeInfo = {
  grader: Grader | null;
  /** Numeric grade, e.g. 10, 9.5. Null when raw/ungraded. */
  grade: number | null;
  /** Sub-designation that changes the market: "BLACK" (BGS) or "PRISTINE" (CGC). */
  qualifier: "BLACK" | "PRISTINE" | null;
  /**
   * Canonical key for grouping prices. Stable and safe as a DB key.
   * Examples: "raw", "PSA10", "BGS9.5", "BGS10-BLACK", "CGC10", "CGC10-PRISTINE".
   */
  key: string;
};

export const RAW: GradeInfo = { grader: null, grade: null, qualifier: null, key: "raw" };

/**
 * Parse grading out of a free-text listing title.
 *
 * Deliberately conservative: anything not clearly identifiable is treated as
 * RAW. A mis-parse that promotes a raw card to "PSA 10" would corrupt the most
 * valuable price bucket, whereas missing a slab merely leaves it out.
 */
export function parseGrade(title: string): GradeInfo {
  const t = title.toUpperCase();

  // Black Label first — "BGS 10 BLACK LABEL" also matches the plain BGS 10
  // pattern, and the more specific reading is the correct one.
  const black =
    /\bBGS\b[^A-Z0-9]{0,6}10\b[^A-Z0-9]{0,12}BLACK|BLACK\s*LABEL/.test(t) &&
    /\bBGS\b/.test(t);
  if (black) {
    return { grader: "BGS", grade: 10, qualifier: "BLACK", key: "BGS10-BLACK" };
  }

  // CGC Pristine 10 is a HIGHER designation than CGC 10 (unlike BGS, where 10
  // and Pristine are the same thing), so it gets its own bucket.
  if (/\bCGC\b/.test(t) && /PRISTINE/.test(t) && /\b10\b/.test(t)) {
    return { grader: "CGC", grade: 10, qualifier: "PRISTINE", key: "CGC10-PRISTINE" };
  }

  // No `\b` after the grader: "PSA10" has no boundary between letters and
  // digits, and sellers write it both ways. The separator class excludes
  // alphanumerics, so "PSAX10" still can't match.
  const m = t.match(/\b(PSA|BGS|CGC|SGC)[^A-Z0-9]{0,6}(10|9\.5|9|8\.5|8|7|6|5)\b/);
  if (m) {
    const grader = m[1] as Grader;
    const grade = Number(m[2]);
    // "BGS 10 Pristine" is just BGS 10 — do NOT mint a separate bucket for it.
    return { grader, grade, qualifier: null, key: `${grader}${m[2]}` };
  }

  return RAW;
}

/** Which printing of a card a listing refers to. */
export type Printing = {
  isSignature: boolean;
  isOvernumbered: boolean;
  isAlternateArt: boolean;
  /** Canonical key: "base", "alt", "over", "sig", "over-sig", … */
  key: string;
};

/**
 * Printing key from the flags we already store on `Product`.
 *
 * Signature and overnumbered are independent: an "overnumbered signature" is its
 * own printing and its own market, which is why the key composes rather than
 * picking one label.
 */
export function printingKey(p: {
  isSignature?: boolean | null;
  isOvernumbered?: boolean | null;
  isAlternateArt?: boolean | null;
}): Printing {
  const isSignature = Boolean(p.isSignature);
  const isOvernumbered = Boolean(p.isOvernumbered);
  const isAlternateArt = Boolean(p.isAlternateArt);

  const parts: string[] = [];
  if (isOvernumbered) parts.push("over");
  if (isSignature) parts.push("sig");
  if (isAlternateArt && !isSignature && !isOvernumbered) parts.push("alt");

  return {
    isSignature,
    isOvernumbered,
    isAlternateArt,
    key: parts.length ? parts.join("-") : "base",
  };
}

/**
 * Detect printing from a listing title, for sources that give us only free text.
 *
 * TCGplayer encodes these in the product name — "(Signature)", "(Overnumbered)",
 * "(Alternate Art)" — and eBay sellers write them in prose.
 */
export function parsePrinting(title: string): Printing {
  const t = title.toUpperCase();
  return printingKey({
    isSignature: /\bSIGNATURE\b|\bSIGNED\b/.test(t),
    isOvernumbered: /\bOVERNUMBERED\b|\bOVER-?NUMBERED\b/.test(t),
    isAlternateArt: /\bALTERNATE\s*ART\b|\bALT\s*ART\b/.test(t),
  });
}

/** The full variant key a price is scoped to: printing + grade. */
export function variantKey(printing: Printing, grade: GradeInfo): string {
  return `${printing.key}:${grade.key}`;
}
