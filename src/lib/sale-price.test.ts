import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeSalePrice,
  HEADLINE_CONDITIONS,
  MIN_SAMPLE_SIZE,
  MAX_SALE_AGE_DAYS,
} from "./sale-price";
import { saleId, type TcgSale } from "./tcgplayer-sales";

// Pin "now" so these never depend on the wall clock — with a 30-day age window,
// clock-relative fixtures would start failing a month after they were written.
const NOW = new Date("2026-08-14T00:00:00Z");
const opts = { now: NOW };

function sale(purchasePrice: number, orderDate: string, condition = "Near Mint") {
  return { purchasePrice, orderDate, condition };
}

/** N days before NOW, as an ISO string. */
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

describe("computeSalePrice", () => {
  test("uses the median, not the mean", () => {
    // Real observed shape: three sales at $850 and one outlier at $1099. A mean
    // would report ~$912 — a price at which nothing actually sold.
    const r = computeSalePrice(
      [
        sale(850, daysAgo(3)),
        sale(850, daysAgo(3)),
        sale(850, daysAgo(2)),
        sale(1099, daysAgo(1)),
      ],
      opts,
    );
    assert.equal(r.price, 850);
    assert.equal(r.reason, "ok");
  });

  test("averages the middle two on an even sample", () => {
    const r = computeSalePrice(
      [sale(10, daysAgo(4)), sale(20, daysAgo(3)), sale(30, daysAgo(2)), sale(40, daysAgo(1))],
      opts,
    );
    assert.equal(r.price, 25);
  });

  test("excludes conditions below Near Mint", () => {
    // Lightly Played copies of the same card sold ~27% cheaper. Blending them
    // would describe a card nobody can buy.
    const r = computeSalePrice(
      [
        sale(100, daysAgo(1), "Near Mint"),
        sale(100, daysAgo(2), "Near Mint"),
        sale(100, daysAgo(3), "Near Mint"),
        sale(90, daysAgo(1), "Lightly Played"),
        sale(90, daysAgo(1), "Damaged"),
      ],
      opts,
    );
    assert.equal(r.price, 100);
    assert.equal(r.sampleSize, 3);
  });

  test("treats sealed 'Unopened' as headline-eligible", () => {
    // Sealed product never sells as Near Mint; excluding Unopened would leave
    // every booster box with no price at all.
    assert.equal(HEADLINE_CONDITIONS.has("Unopened"), true);
    const r = computeSalePrice(
      [
        sale(5.5, daysAgo(1), "Unopened"),
        sale(5.5, daysAgo(2), "Unopened"),
        sale(6.0, daysAgo(3), "Unopened"),
      ],
      opts,
    );
    assert.equal(r.price, 5.5);
  });

  test("takes only the most recent N sales", () => {
    const recent = Array.from({ length: 10 }, (_, i) => sale(100, daysAgo(i + 1)));
    const older = [sale(1, daysAgo(20)), sale(1, daysAgo(21))];
    const r = computeSalePrice([...recent, ...older], { ...opts, sampleSize: 10 });
    assert.equal(r.price, 100);
    assert.equal(r.sampleSize, 10);
  });

  test("reports low/high across the sample", () => {
    const r = computeSalePrice(
      [sale(90, daysAgo(1)), sale(100, daysAgo(2)), sale(110, daysAgo(3))],
      opts,
    );
    assert.equal(r.low, 90);
    assert.equal(r.high, 110);
    assert.equal(r.price, 100);
  });

  describe("accuracy guards", () => {
    test("refuses to price from too few sales", () => {
      // Measured live: 18 products were priced off a SINGLE sale, one of them
      // landing 5.8x above market. With n=1 the median is just that sale.
      const r = computeSalePrice([sale(1599.99, daysAgo(1))], opts);
      assert.equal(r.price, null);
      assert.equal(r.reason, "too-few");
      // The evidence is still reported so the UI can explain itself.
      assert.equal(r.lastSaleAt?.toISOString(), daysAgo(1));
    });

    test(`${MIN_SAMPLE_SIZE} sales is enough`, () => {
      const r = computeSalePrice(
        Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) => sale(50, daysAgo(i + 1))),
        opts,
      );
      assert.equal(r.price, 50);
      assert.equal(r.reason, "ok");
    });

    test("refuses to price from stale sales", () => {
      // Measured live: a Metal Irelia reporting $1,300 from one sale 2.5 months
      // earlier, presented as the current price.
      const r = computeSalePrice(
        [sale(1300, daysAgo(76)), sale(1300, daysAgo(80)), sale(1300, daysAgo(90))],
        opts,
      );
      assert.equal(r.price, null);
      assert.equal(r.reason, "too-old");
    });

    test("ignores sales outside the window when counting the sample", () => {
      // Two recent + two ancient must NOT add up to a passing sample of four.
      const r = computeSalePrice(
        [
          sale(10, daysAgo(1)),
          sale(10, daysAgo(2)),
          sale(10, daysAgo(MAX_SALE_AGE_DAYS + 10)),
          sale(10, daysAgo(MAX_SALE_AGE_DAYS + 20)),
        ],
        opts,
      );
      assert.equal(r.price, null);
      assert.equal(r.reason, "too-few");
    });

    test("a sale exactly at the window edge still counts", () => {
      const r = computeSalePrice(
        [
          sale(10, daysAgo(MAX_SALE_AGE_DAYS - 0.1)),
          sale(10, daysAgo(1)),
          sale(10, daysAgo(2)),
        ],
        opts,
      );
      assert.equal(r.reason, "ok");
      assert.equal(r.sampleSize, 3);
    });

    test("distinguishes no-sales from too-old", () => {
      assert.equal(computeSalePrice([], opts).reason, "no-sales");
      assert.equal(
        computeSalePrice([sale(5, daysAgo(1), "Damaged")], opts).reason,
        "no-sales",
      );
    });
  });

  test("ignores non-positive prices", () => {
    const r = computeSalePrice(
      [sale(0, daysAgo(1)), sale(50, daysAgo(2)), sale(50, daysAgo(3)), sale(50, daysAgo(4))],
      opts,
    );
    assert.equal(r.price, 50);
    assert.equal(r.sampleSize, 3);
  });

  test("lastSaleAt is the newest qualifying sale", () => {
    const r = computeSalePrice(
      [sale(10, daysAgo(5)), sale(20, daysAgo(1)), sale(15, daysAgo(3))],
      opts,
    );
    assert.equal(r.lastSaleAt?.toISOString(), daysAgo(1));
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
