import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scoreDeal,
  isComparableListing,
  isCatalogueListing,
  isPlausibleListing,
  isWatchedProduct,
  DEAL_THRESHOLD,
  DEAL_LANGUAGE,
  SUSPICIOUS_DISCOUNT,
} from "./deals";

const listing = (over: Partial<Parameters<typeof scoreDeal>[0]> = {}) => ({
  condition: "Near Mint",
  language: "English",
  printing: "Foil",
  price: 50,
  shippingPrice: 0,
  listingType: "standard",
  ...over,
});

describe("isCatalogueListing — the Chinese-box filter", () => {
  test("standard listings are the catalogue product", () => {
    assert.equal(isCatalogueListing(listing({ listingType: "standard" })), true);
  });

  test("custom listings are excluded outright", () => {
    // Observed on Spiritforged - Booster Display ($187 benchmark): a dozen
    // CUSTOM listings at $35-95 titled "CHINESE ... SLIM" (24 packs x 5 cards)
    // and "CHINESE ... JUMBO" (12 packs x 14 cards). Different print run AND a
    // different box configuration, sold under the English box's page.
    assert.equal(isCatalogueListing(listing({ listingType: "custom" })), false);
  });

  test("the language field cannot catch these — every listing says English", () => {
    // All 7,021 collected listings reported language="English", including every
    // Chinese box. This is why the filter is structural, not language-based.
    const chineseBox = listing({
      listingType: "custom",
      language: "English",
      customTitle: "CHINESE - Spiritforged Booster Box - SLIM",
    });
    assert.equal(chineseBox.language, DEAL_LANGUAGE);
    assert.equal(isComparableListing(chineseBox), false);
  });

  test("a foreign marker in a custom title also disqualifies", () => {
    // Defence in depth, in case custom listings are ever deliberately admitted.
    for (const title of [
      "CHINESE SLIM BOX SEALED",
      "*Chinese* JUMBO Spiritforged Booster Box",
      "(Simplified Chinese) Riftbound Spiritforged Slim Booster Box",
      "Japanese booster box",
    ]) {
      assert.equal(
        isCatalogueListing({ ...listing(), listingType: "standard", customTitle: title }),
        false,
        title,
      );
    }
  });

  test("an ordinary custom title without a foreign marker is still excluded by type", () => {
    assert.equal(
      isCatalogueListing(listing({ listingType: "custom", customTitle: "Nice box!" })),
      false,
    );
  });

  test("a missing listingType is treated as standard", () => {
    // Older stored rows predate the column; don't retroactively hide them.
    assert.equal(isCatalogueListing(listing({ listingType: null })), true);
  });
});

describe("isComparableListing", () => {
  test("Near Mint English is comparable", () => {
    assert.equal(isComparableListing(listing()), true);
  });

  test("sealed 'Unopened' is comparable", () => {
    assert.equal(isComparableListing(listing({ condition: "Unopened" })), true);
  });

  describe("condition — the reason this filter exists", () => {
    // Every tier below Near Mint sells at a discount BECAUSE it is worse. Against
    // a Near Mint benchmark they'd all read as permanent bargains.
    for (const condition of [
      "Lightly Played",
      "Moderately Played",
      "Heavily Played",
      "Damaged",
    ]) {
      test(`${condition} is excluded`, () => {
        assert.equal(isComparableListing(listing({ condition })), false);
      });
    }

    test("is an allow-list, not a Damaged block-list", () => {
      // Blocking only "Damaged" would still let Heavily Played copies through.
      assert.equal(isComparableListing(listing({ condition: "Near Mint Foil" })), false);
    });
  });

  describe("language", () => {
    // Foreign printings trade at genuinely different levels — against an English
    // benchmark they'd look like permanent 40-70% deals that can never be acted on.
    for (const language of ["Chinese (S)", "Chinese (T)", "Japanese", "Korean"]) {
      test(`${language} is excluded`, () => {
        assert.equal(isComparableListing(listing({ language })), false);
      });
    }
  });

  test("non-positive prices are excluded", () => {
    assert.equal(isComparableListing(listing({ price: 0 })), false);
  });
});

describe("isPlausibleListing — the phantom-listing cross-check", () => {
  test("rejects listings far below TCGplayer's own lowest ask", () => {
    // Measured: the search index served these three, none purchasable.
    assert.equal(isPlausibleListing(108.99, 459.98), false); // Heimerdinger
    assert.equal(isPlausibleListing(27.38, 84.0), false); // Caitlyn
    assert.equal(isPlausibleListing(13.93, 28.66), false); // Invert Timelines
  });

  test("accepts listings at or near the lowest ask", () => {
    // Genuine listings sit at listing ~= lowPrice — often the deal IS the low
    // ask, e.g. Fury Rune listed $11.77 with lowPrice $11.77 against $20 value.
    assert.equal(isPlausibleListing(11.77, 11.77), true);
    assert.equal(isPlausibleListing(12.95, 11.77), true); // above low, fine
    assert.equal(isPlausibleListing(0.39, 0.25), true);
  });

  test("rejects the middle band that looked plausible but wasn't", () => {
    // The first attempt allowed anything above half the low ask, which let
    // Next-Gen Games' Yasuo through at ratio 0.57 — the same seller as two
    // already-confirmed phantoms. lowPrice is TCGplayer's MINIMUM ask, so a
    // real listing cannot sit meaningfully below it.
    assert.equal(isPlausibleListing(17.08, 29.99), false); // ratio 0.57
    assert.equal(isPlausibleListing(2.49, 4.0), false); // ratio 0.62
    assert.equal(isPlausibleListing(5.0, 6.09), false); // ratio 0.82
  });

  test("allows 5% slack for rounding and intraday drift", () => {
    assert.equal(isPlausibleListing(95, 100), true);
    assert.equal(isPlausibleListing(94, 100), false);
  });

  test("no lowPrice means no second opinion — allowed, not rejected", () => {
    // Brand-new products have no daily price sync yet; a new set must not be
    // invisible for a day.
    assert.equal(isPlausibleListing(10, null), true);
    assert.equal(isPlausibleListing(10, undefined), true);
    assert.equal(isPlausibleListing(10, 0), true);
  });
});

describe("isWatchedProduct", () => {
  test("high rarity is watched regardless of price", () => {
    assert.equal(isWatchedProduct({ rarity: "Epic", price: 0.05 }), true);
    assert.equal(isWatchedProduct({ rarity: "Showcase", price: 0.05 }), true);
  });

  test("low rarity is watched only above the value floor", () => {
    assert.equal(isWatchedProduct({ rarity: "Common", price: 5 }), true);
    assert.equal(isWatchedProduct({ rarity: "Common", price: 0.5 }), false);
    assert.equal(isWatchedProduct({ rarity: "Uncommon", price: 1 }), false);
  });

  test("missing data is not watched", () => {
    assert.equal(isWatchedProduct({}), false);
  });
});

describe("scoreDeal", () => {
  test("scores a listing below the benchmark", () => {
    const d = scoreDeal(listing({ price: 60 }), 100);
    assert.equal(d?.discount, 0.4);
    assert.equal(d?.savings, 40);
    assert.equal(d?.suspicious, false);
  });

  describe("shipping decides whether a percentage is real money", () => {
    test("rejects a deal whose shipping exceeds the saving", () => {
      // Observed live: Rabadon's Deathcrown listed at $0.10 against a $0.34
      // benchmark — 71% off, saving $0.24, with $1.49 postage. You'd pay four
      // times what the card is worth.
      assert.equal(
        scoreDeal(listing({ price: 0.1, shippingPrice: 1.49 }), 0.34),
        null,
      );
    });

    test("keeps a deal where the saving clears shipping", () => {
      const d = scoreDeal(listing({ price: 60, shippingPrice: 1.49 }), 100);
      assert.equal(d?.netSavings, 38.51);
    });

    test("free shipping leaves the saving intact", () => {
      const d = scoreDeal(listing({ price: 60, shippingPrice: 0 }), 100);
      assert.equal(d?.netSavings, 40);
    });

    test("break-even is not a deal", () => {
      assert.equal(scoreDeal(listing({ price: 60, shippingPrice: 40 }), 100), null);
    });
  });

  test("rejects anything under the threshold", () => {
    assert.equal(scoreDeal(listing({ price: 81 }), 100), null); // 19% off
    assert.notEqual(scoreDeal(listing({ price: 80 }), 100), null); // exactly 20%
  });

  test("rejects listings priced at or above the benchmark", () => {
    assert.equal(scoreDeal(listing({ price: 100 }), 100), null);
    assert.equal(scoreDeal(listing({ price: 150 }), 100), null);
  });

  test("an incomparable listing is never a deal, however cheap", () => {
    // The whole point: a Damaged card at 90% off is not a deal, it's a damaged
    // card. Same for a Chinese printing.
    assert.equal(scoreDeal(listing({ price: 5, condition: "Damaged" }), 100), null);
    assert.equal(scoreDeal(listing({ price: 5, language: "Japanese" }), 100), null);
  });

  test("no benchmark means no deal", () => {
    // Never invent a comparison — a missing price is unknown, not zero.
    assert.equal(scoreDeal(listing(), null), null);
    assert.equal(scoreDeal(listing(), 0), null);
    assert.equal(scoreDeal(listing(), undefined), null);
  });

  test("flags implausible discounts instead of hiding them", () => {
    // Observed live: Worlds Bundle sales all ~$1,000 while six listings sat at
    // $50-$120 unsold. Shown, but flagged and ranked below credible deals.
    const d = scoreDeal(listing({ price: 50 }), 1000);
    assert.equal(d?.suspicious, true);
    assert.equal(Math.round((d?.discount ?? 0) * 100), 95);
  });

  test("the suspicious boundary is inclusive", () => {
    const at = scoreDeal(listing({ price: 100 * (1 - SUSPICIOUS_DISCOUNT) }), 100);
    assert.equal(at?.suspicious, true);
    const below = scoreDeal(listing({ price: 100 * (1 - SUSPICIOUS_DISCOUNT) + 1 }), 100);
    assert.equal(below?.suspicious, false);
  });

  test("threshold is configurable without changing the default", () => {
    assert.equal(DEAL_THRESHOLD, 0.2);
    assert.notEqual(scoreDeal(listing({ price: 95 }), 100, 0.05), null);
  });
});
