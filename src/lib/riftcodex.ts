// Riftbound card metadata, via the Riftcodex open API (api.riftcodex.com).
//
// tcgcsv already gives us rarity/number/card text for singles, so why a second
// source? Two things only Riftcodex has:
//   1. `tcgplayer_id` — an explicit join key back to the TCGplayer product, so we
//      never have to fuzzy-match on card names (which are formatted differently
//      on each side, e.g. "Vi - Piltover Enforcer (Signature)").
//   2. Riot's own CMS art URLs + artist credit + the canonical `riftbound_id`
//      (e.g. "unl-229*-219"), which TCGplayer does not carry.
//
// No auth required for reads. Page size caps at 100.

const BASE = process.env.RIFTCODEX_BASE ?? "https://api.riftcodex.com";

export type RiftcodexCard = {
  id: string;
  name: string;
  riftbound_id: string | null;
  /** TCGplayer productId as a string — our join key. May be null for unlisted cards. */
  tcgplayer_id: string | null;
  collector_number: number | null;
  attributes: { energy: number | null; might: number | null; power: number | null };
  classification: {
    type: string | null;
    supertype: string | null;
    rarity: string | null;
    domain: string[] | null;
  };
  text: { rich: string | null; plain: string | null; flavour: string | null };
  set: { set_id: string | null; label: string | null };
  media: {
    image_url: string | null;
    artist: string | null;
    accessibility_text: string | null;
  };
  tags: string[] | null;
  orientation: string | null;
  metadata: {
    clean_name: string | null;
    updated_on: string | null;
    alternate_art: boolean;
    overnumbered: boolean;
    signature: boolean;
  };
  new: boolean;
};

type CardsPage = {
  items: RiftcodexCard[];
  total: number;
  page: number;
  size: number;
  pages: number;
};

/**
 * Every card in the Riftcodex database, walking pagination to exhaustion.
 *
 * Pages are fetched sequentially rather than in parallel: this is ~15 requests
 * against a small community API, and being polite costs us about a second.
 */
export async function fetchAllCards(
  onProgress?: (fetched: number, total: number) => void,
): Promise<RiftcodexCard[]> {
  const size = 100; // API maximum
  const all: RiftcodexCard[] = [];
  let page = 1;
  let pages = 1;

  do {
    const url = `${BASE}/cards?page=${page}&size=${size}`;
    const res = await fetch(url, {
      // Identify the project rather than sending a bare/default agent — some
      // hosts reject unknown clients outright.
      headers: {
        accept: "application/json",
        "user-agent":
          "RiftboundMarketWatch/0.1 (+https://github.com/kevinyindevelopment/RiftboundMarketWatch)",
      },
    });
    if (!res.ok) {
      throw new Error(`riftcodex ${res.status} ${res.statusText} for ${url}`);
    }
    const body = (await res.json()) as CardsPage;
    all.push(...body.items);
    pages = body.pages;
    onProgress?.(all.length, body.total);
    page += 1;
  } while (page <= pages);

  return all;
}

/**
 * Index cards by TCGplayer productId for joining onto tcgcsv products.
 *
 * Cards with no `tcgplayer_id` are dropped — they have nothing to join to. If two
 * cards ever claim the same id, first wins (the API returns them in a stable
 * sort, so this stays deterministic run to run).
 */
export function indexByTcgplayerId(
  cards: RiftcodexCard[],
): Map<number, RiftcodexCard> {
  const byId = new Map<number, RiftcodexCard>();
  for (const card of cards) {
    if (!card.tcgplayer_id) continue;
    const id = Number(card.tcgplayer_id);
    if (!Number.isFinite(id)) continue;
    if (!byId.has(id)) byId.set(id, card);
  }
  return byId;
}

/** Index by lowercased `riftbound_id`, for the derived-key fallback join. */
export function indexByRiftboundId(
  cards: RiftcodexCard[],
): Map<string, RiftcodexCard> {
  const byId = new Map<string, RiftcodexCard>();
  for (const card of cards) {
    if (!card.riftbound_id) continue;
    const key = card.riftbound_id.toLowerCase();
    if (!byId.has(key)) byId.set(key, card);
  }
  return byId;
}

/**
 * Rebuild a card's `riftbound_id` from the set code + TCGplayer collector number.
 *
 * Riftcodex assigns `tcgplayer_id` by hand, so it lags a new set's release by
 * weeks — at the time of writing every one of Vendetta's 227 cards was unlinked.
 * But the two id schemes are mechanically related:
 *
 *   set "VEN" + TCGplayer number "150/166"  ->  "ven-150-166"
 *   set "VEN" + TCGplayer number "084a/166" ->  "ven-084a-166"   (alternate art)
 *   set "UNL" + TCGplayer number "229{star}/219" -> "unl-229{star}-219" (signature)
 *
 * ({star} is a literal asterisk — spelled out here because the sequence would
 * otherwise close this comment block.)
 *
 * The variant markers (a, asterisk) that make name-matching ambiguous are exactly
 * what makes THIS key precise. Verified against all 1223 cards that already
 * carry a `tcgplayer_id`: 1223 agreements, 0 disagreements.
 *
 * Returns null when the number isn't in `n/total` form (e.g. runes are "R04a"),
 * since the rule doesn't apply there.
 */
export function deriveRiftboundId(
  setCode: string | null | undefined,
  tcgplayerNumber: string | null | undefined,
): string | null {
  if (!setCode || !tcgplayerNumber) return null;
  if (!tcgplayerNumber.includes("/")) return null;
  return `${setCode}-${tcgplayerNumber.replace("/", "-")}`.toLowerCase();
}
