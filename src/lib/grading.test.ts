import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseGrade, parsePrinting, printingKey, variantKey } from "./grading";

describe("parseGrade", () => {
  test("ungraded listings are raw", () => {
    assert.equal(parseGrade("Riftbound Ahri Nine-Tailed Fox Signature NM").key, "raw");
    assert.equal(parseGrade("").key, "raw");
  });

  test("PSA grades", () => {
    assert.equal(parseGrade("Ahri Signature PSA 10 GEM MINT").key, "PSA10");
    assert.equal(parseGrade("Ahri PSA 9").key, "PSA9");
    assert.equal(parseGrade("Ahri PSA10").key, "PSA10");
  });

  describe("BGS vs CGC 'Pristine' — the easy thing to get wrong", () => {
    test("BGS 10 and 'BGS 10 Pristine' are the SAME grade", () => {
      // BGS *calls* a 10 "Pristine". Treating the word as a separate tier would
      // split one market into two half-populated buckets.
      assert.equal(parseGrade("Teemo BGS 10").key, "BGS10");
      assert.equal(parseGrade("Teemo BGS 10 PRISTINE").key, "BGS10");
    });

    test("BGS 10 Black Label is distinct and much rarer", () => {
      // All four subgrades 10 — a materially different market from a plain 10.
      assert.equal(parseGrade("Teemo BGS 10 BLACK LABEL").key, "BGS10-BLACK");
      assert.equal(parseGrade("Teemo BGS 10 Black").key, "BGS10-BLACK");
    });

    test("CGC 10 and CGC Pristine 10 ARE different", () => {
      // Opposite shape to BGS: CGC 10 is Gem Mint, Pristine 10 is above it.
      assert.equal(parseGrade("Ahri CGC 10").key, "CGC10");
      assert.equal(parseGrade("Ahri CGC Pristine 10").key, "CGC10-PRISTINE");
    });

    test("'Pristine' without CGC/BGS context does not invent a grade", () => {
      assert.equal(parseGrade("Ahri pristine condition raw card").key, "raw");
    });
  });

  test("half grades", () => {
    assert.equal(parseGrade("Ahri BGS 9.5 GEM MINT").key, "BGS9.5");
  });

  test("SGC and separators", () => {
    assert.equal(parseGrade("Ahri SGC 10").key, "SGC10");
    assert.equal(parseGrade("Ahri PSA-10").key, "PSA10");
  });

  test("is conservative: unclear text stays raw", () => {
    // A mis-parse that promotes a raw card into the PSA 10 bucket corrupts the
    // most valuable price. Missing a slab only omits it.
    assert.equal(parseGrade("Ahri lot of 10 cards").key, "raw");
    assert.equal(parseGrade("10 card bundle riftbound").key, "raw");
  });

  test("reports structured fields, not just the key", () => {
    const g = parseGrade("BGS 10 Black Label");
    assert.equal(g.grader, "BGS");
    assert.equal(g.grade, 10);
    assert.equal(g.qualifier, "BLACK");
  });
});

describe("printingKey", () => {
  test("base printing", () => {
    assert.equal(printingKey({}).key, "base");
  });

  test("signature and overnumbered are independent axes", () => {
    // An overnumbered signature is its own printing and its own market — the
    // key must compose rather than pick a winner.
    assert.equal(printingKey({ isSignature: true }).key, "sig");
    assert.equal(printingKey({ isOvernumbered: true }).key, "over");
    assert.equal(
      printingKey({ isSignature: true, isOvernumbered: true }).key,
      "over-sig",
    );
  });

  test("alternate art only labels a printing that isn't already distinguished", () => {
    assert.equal(printingKey({ isAlternateArt: true }).key, "alt");
    assert.equal(printingKey({ isAlternateArt: true, isSignature: true }).key, "sig");
  });
});

describe("parsePrinting", () => {
  test("reads TCGplayer-style parenthetical names", () => {
    assert.equal(parsePrinting("Ahri - Inquisitive (Signature)").key, "sig");
    assert.equal(parsePrinting("Ambessa - Respected and Feared (Overnumbered)").key, "over");
    assert.equal(parsePrinting("Ambessa - The Wolf (Alternate Art)").key, "alt");
  });

  test("reads seller prose", () => {
    assert.equal(parsePrinting("Riftbound Ahri OVERNUMBERED SIGNATURE mint").key, "over-sig");
    assert.equal(parsePrinting("riftbound ahri signed alt art").key, "sig");
  });

  test("plain listings are base", () => {
    assert.equal(parsePrinting("Riftbound Ahri Nine-Tailed Fox").key, "base");
  });
});

describe("variantKey", () => {
  test("a price is scoped to printing AND grade", () => {
    // The point of the whole module: these are four different markets, and
    // averaging across them would produce a number describing none of them.
    const raw = parseGrade("");
    const psa10 = parseGrade("PSA 10");
    const sig = parsePrinting("(Signature)");
    const overSig = parsePrinting("Overnumbered Signature");

    const keys = [
      variantKey(sig, raw),
      variantKey(sig, psa10),
      variantKey(overSig, raw),
      variantKey(overSig, psa10),
    ];
    assert.deepEqual(keys, ["sig:raw", "sig:PSA10", "over-sig:raw", "over-sig:PSA10"]);
    assert.equal(new Set(keys).size, 4);
  });
});
