// Tests for normalisation rules that have no error path — if they regress they
// produce plausible-looking wrong data rather than a crash.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { utcDay } from "./collect";
import { extField, type TcgcsvProduct } from "./tcgcsv";

function product(extendedData: TcgcsvProduct["extendedData"] = []): TcgcsvProduct {
  return {
    productId: 1,
    name: "X",
    cleanName: "X",
    imageUrl: "",
    categoryId: 89,
    groupId: 24698,
    url: "",
    modifiedOn: "",
    imageCount: 1,
    presaleInfo: { isPresale: false, releasedOn: null, note: null },
    extendedData,
  };
}

describe("utcDay", () => {
  test("formats as YYYY-MM-DD", () => {
    assert.equal(utcDay(new Date("2026-08-13T18:04:00.000Z")), "2026-08-13");
  });

  test("uses UTC, not local time", () => {
    // The whole reason this helper exists: a GitHub runner (UTC) and a local
    // Windows box (UTC-4/-5) must file the same snapshot under the same date,
    // or the same day's prices land twice under two keys. 03:00 UTC is the
    // previous evening in US timezones — it must still be the 13th.
    assert.equal(utcDay(new Date("2026-08-13T03:00:00.000Z")), "2026-08-13");
    assert.equal(utcDay(new Date("2026-08-13T23:59:59.999Z")), "2026-08-13");
    assert.equal(utcDay(new Date("2026-08-14T00:00:00.000Z")), "2026-08-14");
  });
});

describe("extField", () => {
  test("finds a field by its upstream name", () => {
    const p = product([{ name: "Rarity", displayName: "Rarity", value: "Showcase" }]);
    assert.equal(extField(p, "Rarity"), "Showcase");
  });

  test("returns undefined for an absent field", () => {
    assert.equal(extField(product(), "Rarity"), undefined);
  });
});

describe("sealed detection", () => {
  // Not a function under test so much as a documented invariant: TCGplayer only
  // populates extendedData for singles, and `isSealed` keys off that emptiness.
  // If upstream ever starts sending extendedData on sealed products, sealed
  // boxes would silently be classified as cards and appear in card listings.
  test("empty extendedData is the sealed signal", () => {
    assert.equal(product().extendedData.length === 0, true);
    assert.equal(
      product([{ name: "Rarity", displayName: "Rarity", value: "Common" }])
        .extendedData.length === 0,
      false,
    );
  });
});
