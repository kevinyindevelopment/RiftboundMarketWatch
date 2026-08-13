// Tests for the Riftcodex join logic.
//
// This is the least obvious code in the project and the easiest to break: the
// derived-id rule is what recovers the ~126 cards Riftcodex hasn't hand-linked
// yet, and its whole value rests on the variant markers (`a`, `*`) surviving
// intact. A "tidy-up" that strips punctuation or lowercases differently would
// silently drop those cards back to unenriched — with no error anywhere.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRiftboundId,
  indexByTcgplayerId,
  indexByRiftboundId,
  type RiftcodexCard,
} from "./riftcodex";

function card(overrides: Partial<RiftcodexCard> = {}): RiftcodexCard {
  return {
    id: "abc123",
    name: "Test Card",
    riftbound_id: "ven-150-166",
    tcgplayer_id: "705996",
    collector_number: 150,
    attributes: { energy: null, might: null, power: null },
    classification: { type: null, supertype: null, rarity: null, domain: null },
    text: { rich: null, plain: null, flavour: null },
    set: { set_id: "VEN", label: "Vendetta" },
    media: { image_url: null, artist: null, accessibility_text: null },
    tags: null,
    orientation: null,
    metadata: {
      clean_name: null,
      updated_on: null,
      alternate_art: false,
      overnumbered: false,
      signature: false,
    },
    new: false,
    ...overrides,
  };
}

describe("deriveRiftboundId", () => {
  test("builds the canonical id from set code + collector number", () => {
    assert.equal(deriveRiftboundId("VEN", "150/166"), "ven-150-166");
  });

  test("preserves the alternate-art suffix", () => {
    // "084a" vs "084" are different printings at different prices. Dropping the
    // 'a' would join an alt-art product to the base card's art.
    assert.equal(deriveRiftboundId("VEN", "084a/166"), "ven-084a-166");
  });

  test("preserves the signature asterisk", () => {
    // The asterisk is load-bearing, and is exactly what name-matching cannot
    // distinguish (measured: 16 ambiguous names, 0 ambiguous derived ids).
    assert.equal(deriveRiftboundId("UNL", "229*/219"), "unl-229*-219");
  });

  test("handles special-print prefixes", () => {
    assert.equal(deriveRiftboundId("VEN", "SP3/006"), "ven-sp3-006");
  });

  test("lowercases the set code", () => {
    assert.equal(deriveRiftboundId("OGN", "001/298"), "ogn-001-298");
  });

  test("returns null when the number is not in n/total form", () => {
    // Runes are numbered "R04a" with no total — the rule doesn't apply, and
    // guessing would produce a wrong id rather than no id.
    assert.equal(deriveRiftboundId("VEN", "R04a"), null);
  });

  test("returns null on missing inputs", () => {
    assert.equal(deriveRiftboundId(null, "150/166"), null);
    assert.equal(deriveRiftboundId("VEN", null), null);
    assert.equal(deriveRiftboundId(undefined, undefined), null);
    // Promo groups (PR/OPP/JDG) have no Riftcodex set and must not be forced.
    assert.equal(deriveRiftboundId("", "150/166"), null);
  });
});

describe("indexByTcgplayerId", () => {
  test("indexes by numeric product id", () => {
    const idx = indexByTcgplayerId([card({ tcgplayer_id: "705996" })]);
    assert.equal(idx.get(705996)?.id, "abc123");
  });

  test("skips cards with no tcgplayer_id", () => {
    // The normal state for a freshly-released set — all 227 Vendetta cards were
    // unlinked at first. These must be dropped, not indexed as NaN.
    const idx = indexByTcgplayerId([card({ tcgplayer_id: null })]);
    assert.equal(idx.size, 0);
  });

  test("skips non-numeric ids rather than storing NaN", () => {
    const idx = indexByTcgplayerId([card({ tcgplayer_id: "not-a-number" })]);
    assert.equal(idx.size, 0);
  });

  test("first card wins on duplicate ids, deterministically", () => {
    const idx = indexByTcgplayerId([
      card({ id: "first", tcgplayer_id: "1" }),
      card({ id: "second", tcgplayer_id: "1" }),
    ]);
    assert.equal(idx.get(1)?.id, "first");
  });
});

describe("indexByRiftboundId", () => {
  test("keys are lowercased so the derived id matches", () => {
    const idx = indexByRiftboundId([card({ riftbound_id: "VEN-150-166" })]);
    assert.equal(idx.get("ven-150-166")?.id, "abc123");
  });

  test("round-trips against deriveRiftboundId", () => {
    // The property that actually matters: what we derive is what we can look up.
    const cards = [
      card({ id: "a", riftbound_id: "ven-084a-166" }),
      card({ id: "b", riftbound_id: "unl-229*-219" }),
      card({ id: "c", riftbound_id: "ven-sp3-006" }),
    ];
    const idx = indexByRiftboundId(cards);
    assert.equal(idx.get(deriveRiftboundId("VEN", "084a/166")!)?.id, "a");
    assert.equal(idx.get(deriveRiftboundId("UNL", "229*/219")!)?.id, "b");
    assert.equal(idx.get(deriveRiftboundId("VEN", "SP3/006")!)?.id, "c");
  });

  test("skips cards with no riftbound_id", () => {
    const idx = indexByRiftboundId([card({ riftbound_id: null })]);
    assert.equal(idx.size, 0);
  });
});
