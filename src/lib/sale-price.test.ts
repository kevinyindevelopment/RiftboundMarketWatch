import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeSalePrice, HEADLINE_CONDITIONS } from "./sale-price";
import { saleId, type TcgSale } from "./tcgplayer-sales";

function sale(
  purchasePrice: number,
  orderDate: string,
  condition = "Near Mint",
): { purchasePrice: number; orderDate: string; condition: string } {
  return { purchasePrice, orderDate, condition };
}

describe("computeSalePrice", () => {
  test("uses the median, not the mean", () => {
    // Real observed shape: three sales at $850 and one outlier at $1099. A mean
    // would report ~$912 — a price at which nothing actually sold.
    const r = computeSalePrice([
      sale(850, "2026-08-05T06:56:40Z"),
      sale(850, "2026-08-05T06:56:41Z"),
      sale(850, "2026-08-05T07:00:00Z"),
      sale(1099, "2026-08-05T09:01:19Z"),
    ]);
    assert.equal(r.price, 850);
  });

  test("averages the middle two on an even sample", () => {
    const r = computeSalePrice([
      sale(10, "2026-08-01T00:00:00Z"),
      sale(20, "2026-08-02T00:00:00Z"),
    ]);
    assert.equal(r.price, 15);
  });

  test("excludes conditions below Near Mint", () => {
    // Lightly Played copies of the same card sold ~27% cheaper. Blending them
    // would describe a card nobody can buy.
    const r = computeSalePrice([
      sale(100, "2026-08-13T17:39:21Z", "Near Mint"),
      sale(100, "2026-08-13T15:38:11Z", "Near Mint"),
      sale(90, "2026-08-13T19:19:40Z", "Lightly Played"),
      sale(90, "2026-08-13T18:26:17Z", "Lightly Played"),
    ]);
    assert.equal(r.price, 100);
    assert.equal(r.sampleSize, 2);
  });

  test("treats sealed 'Unopened' as headline-eligible", () => {
    // Sealed product never sells as Near Mint; excluding Unopened would leave
    // every booster box with no price at all.
    assert.equal(HEADLINE_CONDITIONS.has("Unopened"), true);
    const r = computeSalePrice([sale(5.5, "2026-08-12T22:44:21Z", "Unopened")]);
    assert.equal(r.price, 5.5);
  });

  test("takes only the most recent N sales", () => {
    // 12 sales: the oldest two (at $1) must not drag the median down.
    const sales = [
      ...Array.from({ length: 10 }, (_, i) =>
        sale(100, `2026-08-${String(10 + Math.floor(i / 5)).padStart(2, "0")}T0${i % 5}:00:00Z`),
      ),
      sale(1, "2026-01-01T00:00:00Z"),
      sale(1, "2026-01-02T00:00:00Z"),
    ];
    const r = computeSalePrice(sales, 10);
    assert.equal(r.price, 100);
    assert.equal(r.sampleSize, 10);
  });

  test("reports low/high across the sample", () => {
    const r = computeSalePrice([
      sale(90, "2026-08-03T00:00:00Z"),
      sale(100, "2026-08-02T00:00:00Z"),
      sale(110, "2026-08-01T00:00:00Z"),
    ]);
    assert.equal(r.low, 90);
    assert.equal(r.high, 110);
    assert.equal(r.price, 100);
  });

  test("returns nulls rather than 0 when nothing qualifies", () => {
    // A card with only played copies has no headline price — which must not be
    // confused with "this card is free".
    const r = computeSalePrice([sale(5, "2026-08-01T00:00:00Z", "Damaged")]);
    assert.equal(r.price, null);
    assert.equal(r.sampleSize, 0);
    assert.equal(r.lastSaleAt, null);
  });

  test("ignores non-positive prices", () => {
    const r = computeSalePrice([
      sale(0, "2026-08-02T00:00:00Z"),
      sale(50, "2026-08-01T00:00:00Z"),
    ]);
    assert.equal(r.price, 50);
  });

  test("lastSaleAt is the newest qualifying sale", () => {
    const r = computeSalePrice([
      sale(10, "2026-08-01T00:00:00Z"),
      sale(20, "2026-08-09T12:00:00Z"),
    ]);
    assert.equal(r.lastSaleAt?.toISOString(), "2026-08-09T12:00:00.000Z");
  });
});

describe("saleId", () => {
  const base: TcgSale = {
    condition: "Near Mint",
    variant: "Foil",
    language: "English",
    quantity: 1,
    title: "Ahri",
    listingType: "ListingWithoutPhotos",
    customListingId: "abc",
    purchasePrice: 100.3,
    shippingPrice: 0,
    orderDate: "2026-08-13T17:39:21",
  };

  test("is stable for identical input", () => {
    assert.equal(saleId(705996, base), saleId(705996, { ...base }));
  });

  test("differs by shipping", () => {
    // Two genuine sales were observed at the same second, same price and
    // quantity, differing ONLY in shipping. If shipping weren't part of the key
    // they would collapse into one and a real sale would be lost.
    assert.notEqual(saleId(705996, base), saleId(705996, { ...base, shippingPrice: 2 }));
  });

  test("differs by product, price, condition, variant and date", () => {
    const id = saleId(705996, base);
    assert.notEqual(id, saleId(705997, base));
    assert.notEqual(id, saleId(705996, { ...base, purchasePrice: 100.31 }));
    assert.notEqual(id, saleId(705996, { ...base, condition: "Lightly Played" }));
    assert.notEqual(id, saleId(705996, { ...base, variant: "Normal" }));
    assert.notEqual(id, saleId(705996, { ...base, orderDate: "2026-08-13T17:39:22" }));
  });

  test("ignores listing metadata that is not part of sale identity", () => {
    // customListingId identifies the LISTING and recurs across separate sales,
    // so including it would let the same sale be stored twice.
    assert.equal(saleId(705996, base), saleId(705996, { ...base, customListingId: "zzz" }));
  });
});
