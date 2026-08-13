import Link from "next/link";
import { getBoxEvPageData, type BoxEvSet } from "@/lib/queries";
import { BOX_ASSUMPTIONS as A, computeBoxEv, type BoxEv, type Printing } from "@/lib/box-ev";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Box EV — Riftbound Market Watch",
  description:
    "What a sealed Riftbound booster box is worth, from worst-case pull rates and real sale prices.",
};

function money(n: number | null, dp = 2) {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

const PRINTING_LABEL: Record<Printing, string> = {
  base: "",
  "alt-art": "Alt art",
  overnumbered: "Overnumbered",
  signature: "Signature",
  rune: "Rune",
  other: "Other",
};

export default async function BoxEvPage() {
  let data;
  try {
    data = await getBoxEvPageData();
  } catch (err) {
    return (
      <main>
        <BackLink />
        <h1 className="text-3xl font-bold">Box EV</h1>
        <pre className="mt-6 overflow-x-auto rounded bg-zinc-900 p-4 text-xs text-red-300">
          {err instanceof Error ? err.message : String(err)}
        </pre>
      </main>
    );
  }

  return (
    <main className="space-y-10">
      <div>
        <BackLink />
        <h1 className="text-3xl font-bold">Box EV</h1>
        <p className="mt-2 max-w-3xl text-zinc-400">
          What a sealed booster display returns if it opens as badly as the odds allow —
          worst-case pull rates priced against real completed sales.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-zinc-500">
          Only <strong className="text-zinc-400">relevant cards</strong> carry value: Epic
          or better, or worth $1 or more. Bulk counts as $0 — but it stays in the odds, so
          a slot that usually produces bulk is correctly worth almost nothing rather than
          being quietly skipped.
          {data.latest ? ` Prices as of ${data.latest}.` : ""}
        </p>
      </div>

      <Assumptions />

      {data.sets.length === 0 ? (
        <p className="text-zinc-500">No booster sets priced yet.</p>
      ) : (
        data.sets.map((s) => <SetBlock key={s.setCode} set={s} ev={computeBoxEv(s.pools)} />)
      )}

      <section className="max-w-3xl space-y-2 border-t border-zinc-800 pt-6 text-sm text-zinc-500">
        <h2 className="font-semibold text-zinc-400">How the number is built</h2>
        <p>
          Each slot&apos;s value is the average over <em>every</em> card it can produce,
          with bulk contributing $0 and the full pool as the denominator. A pull always
          produces something, so dropping the cheap cards from the pool instead of valuing
          them at zero would inflate the result — for Spiritforged&apos;s Epics alone that
          is the difference between $6.40 and $10.30 a pull.
        </p>
        <p>
          Rare, Epic and Showcase cards are only ever printed foil in Riftbound, so their
          foil price <em>is</em> their price. Commons and Uncommons have both finishes: the{" "}
          {A.commonsPerPack} + {A.uncommonsPerPack} base slots use the Normal price, and the
          1 foil slot uses the foil. That foil slot is treated as a Common or Uncommon,
          because a foil Rare would be the same product the rare-or-better slots have
          already paid for.
        </p>
        <p>
          <strong className="text-zinc-400">Only a price someone actually paid counts.</strong>{" "}
          Every figure above is the median of recent completed sales. Cards priced solely
          from TCGplayer&apos;s market estimate are shown, marked{" "}
          <span className="text-amber-600/70">est.</span>, and contribute nothing — an
          estimate nobody has paid is not value you can realise. The slot table reports
          what that exclusion costs.
        </p>
        <p>
          This is not a technicality. Every foil Common and Uncommon that TCGplayer values
          above $1 has <em>zero</em> recorded sales — Origins alone claimed $132.77 of them
          (Stacked Deck &quot;$18.68&quot;, Defy &quot;$9.33&quot;). Where a foil Common or
          Uncommon genuinely does sell, and 597 such sales are on record across these four
          sets, it goes for $0.06 to $0.90. The estimates weren&apos;t roughly right; they
          were contradicted by every real sale of the same kind of card. The big slots are
          unaffected — Rare, Epic, alternate art and overnumbered are entirely
          sales-derived in all four sets.
        </p>
      </section>
    </main>
  );
}

/**
 * The model, stated rather than offered as knobs. These rates are known, so
 * making them editable would only invite the reader to make the number wrong.
 */
function Assumptions() {
  const items: [string, string][] = [
    ["Packs per box", `${A.packsPerBox}`],
    ["Per pack", `${A.commonsPerPack}C · ${A.uncommonsPerPack}U · ${A.rarePlusPerPack} rare+ · ${A.foilsPerPack} foil`],
    ["Epics per box", `${A.epicsPerBox}`],
    ["Alt arts per box", `${A.altArtsPerBox}`],
    ["Overnumbered", `1 per ${A.boxesPerOvernumbered} boxes`],
    ["Of those, Signature", `${Math.round(A.signatureShareOfOvernumbered * 100)}%`],
  ];
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="text-lg font-semibold">Pull rates</h2>
      <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="text-sm text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
        The Epic, alt-art and overnumbered guarantees are drawn <em>from</em> the{" "}
        {A.packsPerBox * A.rarePlusPerPack} rare-or-better slots in a box, not added on top
        of them — the leftover slots are ordinary Rares.
      </p>
    </section>
  );
}

function SetBlock({ set: s, ev }: { set: BoxEvSet; ev: BoxEv }) {
  const margin = s.boxPrice != null ? ev.total - s.boxPrice : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">
            {s.setName} <span className="text-sm font-normal text-zinc-500">{s.setCode}</span>
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            {s.boxUrl ? (
              <a href={s.boxUrl} target="_blank" rel="noreferrer" className="hover:underline">
                {s.boxName}
              </a>
            ) : (
              "No booster display priced"
            )}
            {s.boxPrice != null && (
              <>
                {" "}
                costs <strong className="text-zinc-300">{money(s.boxPrice)}</strong>
                {s.boxPriceSource === "market" && (
                  <span className="ml-1 text-amber-600/70" title="Too few recent sales">
                    est.
                  </span>
                )}
              </>
            )}
            {" · "}
            {s.coverage.priced}/{s.coverage.singles} cards priced
          </p>
        </div>

        <div className="flex gap-6 text-right">
          <Stat label="EV per box" value={money(ev.total)} />
          {margin != null && (
            <Stat
              label={margin >= 0 ? "Profit" : "Loss"}
              value={`${margin >= 0 ? "+" : ""}${money(margin)}`}
              tone={margin >= 0 ? "good" : "bad"}
            />
          )}
          <Stat
            label="Typical box"
            value={money(ev.withoutJackpot)}
            hint="EV of a box with no overnumbered/signature hit — which is most of them"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-2">Slot</th>
              <th className="text-right">Pulls/box</th>
              <th className="text-right" title="Cards worth counting / cards in the pool">
                Pool
              </th>
              <th className="text-right" title="Expected value of one pull from this slot">
                Per pull
              </th>
              <th className="text-right">Value</th>
              <th className="text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {ev.lines.map((l) => (
              <tr key={l.slot} className="border-t border-zinc-800">
                <td className="py-2">
                  {l.slot}
                  {l.note && <span className="ml-2 text-xs text-zinc-600">{l.note}</span>}
                </td>
                <td className="text-right text-zinc-400">
                  {l.pulls % 1 === 0 ? l.pulls : l.pulls.toFixed(2)}
                </td>
                <td className="text-right text-zinc-500">
                  {l.pool.relevantN}/{l.pool.n}
                  {l.pool.unverifiedN > 0 && (
                    <span
                      className="ml-1 text-xs text-amber-600/70"
                      title={`${l.pool.unverifiedN} card(s) worth a nominal ${money(
                        l.pool.unverifiedSum,
                      )} on TCGplayer's market estimate, with no recent sales to confirm it — not counted`}
                    >
                      −{l.pool.unverifiedN} est.
                    </span>
                  )}
                </td>
                <td className="text-right text-zinc-400">{money(l.perPull)}</td>
                <td className="text-right">{money(l.value)}</td>
                <td className="text-right text-zinc-500">
                  {ev.total > 0 ? `${Math.round((l.value / ev.total) * 100)}%` : "—"}
                </td>
              </tr>
            ))}
            <tr className="border-t border-zinc-700 font-semibold">
              <td className="py-2">Total</td>
              <td />
              <td />
              <td />
              <td className="text-right">{money(ev.total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <details className="rounded-lg border border-zinc-800 bg-zinc-900/30">
        <summary className="cursor-pointer px-4 py-3 text-sm text-zinc-400 hover:text-zinc-200">
          {s.relevantCards.length} relevant cards — Epic or better, or worth $1+
        </summary>
        <div className="max-h-[28rem] overflow-auto border-t border-zinc-800 px-4 pb-4">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="sticky top-0 bg-zinc-900 text-left text-zinc-500">
              <tr>
                <th className="py-2">Card</th>
                <th>Rarity</th>
                <th className="text-right">Normal</th>
                <th className="text-right">Foil</th>
              </tr>
            </thead>
            <tbody>
              {s.relevantCards.map((c) => (
                <tr key={c.productId} className="border-t border-zinc-800/60">
                  <td className="py-1.5">
                    <a
                      href={c.tcgplayerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {c.name}
                    </a>
                    <span className="ml-2 text-xs text-zinc-600">{c.number}</span>
                  </td>
                  <td className="text-zinc-500">{PRINTING_LABEL[c.printing] || c.rarity}</td>
                  <td className="text-right text-zinc-400">
                    {money(c.normalPrice)}
                    {c.normalPrice != null && !c.normalFromSales && <Est />}
                  </td>
                  <td className="text-right">
                    {money(c.foilPrice)}
                    {c.foilPrice != null && !c.foilFromSales && <Est />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {s.excluded.length > 0 && (
        <p className="text-xs text-zinc-600">
          Not counted (no published pull rate):{" "}
          {s.excluded.map((e) => `${e.name} ${money(e.price)}`).join(" · ")}
        </p>
      )}
    </section>
  );
}

/** Marks a price that came from TCGplayer's market estimate, not real sales. */
function Est() {
  return (
    <span className="ml-1 text-xs text-amber-600/70" title="Too few recent sales — market estimate">
      est.
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div
        className={`text-2xl font-semibold ${
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/" className="mb-4 inline-block text-sm text-zinc-500 hover:text-zinc-300">
      ← All pages
    </Link>
  );
}
