import Link from "next/link";
import { getDealsPageData } from "@/lib/queries";
import { DEAL_THRESHOLD, SUSPICIOUS_DISCOUNT } from "@/lib/deals";

export const dynamic = "force-dynamic";

function money(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function DealsPage() {
  let data;
  try {
    data = await getDealsPageData();
  } catch (err) {
    return (
      <main>
        <BackLink />
        <h1 className="text-3xl font-bold">Deals Tracker</h1>
        <pre className="mt-6 overflow-x-auto rounded bg-zinc-900 p-4 text-xs text-red-300">
          {err instanceof Error ? err.message : String(err)}
        </pre>
      </main>
    );
  }

  const { deals, stats } = data;
  const credible = deals.filter((d) => !d.suspicious);
  const flagged = deals.filter((d) => d.suspicious);

  return (
    <main className="space-y-8">
      <div>
        <BackLink />
        <h1 className="text-3xl font-bold">Deals Tracker</h1>
        <p className="mt-2 text-zinc-400">
          Near Mint English listings at least {Math.round(DEAL_THRESHOLD * 100)}% below
          the card&apos;s current price.
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          {stats.listings.toLocaleString()} live listings across{" "}
          {stats.watched.toLocaleString()} watched products (Epic/Showcase rarity, or
          worth over $1) · {credible.length} deals
          {stats.checkedAt ? ` · updated ${stats.checkedAt}` : ""}
        </p>
      </div>

      {credible.length === 0 ? (
        <p className="text-zinc-500">
          No deals right now. Listings refresh hourly.
        </p>
      ) : (
        <DealTable rows={credible} />
      )}

      {flagged.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-semibold text-amber-400">
            Too good to be true ({flagged.length})
          </h2>
          <p className="mb-3 max-w-3xl text-sm text-zinc-500">
            Listed more than {Math.round(SUSPICIOUS_DISCOUNT * 100)}% below market. These
            are almost always mis-listings rather than bargains — a genuinely underpriced
            item at this level sells within minutes, and these persist across refreshes.
            Shown for completeness; verify carefully before buying.
          </p>
          <DealTable rows={flagged} />
        </section>
      )}
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/" className="mb-4 inline-block text-sm text-zinc-500 hover:text-zinc-300">
      ← All pages
    </Link>
  );
}

type Row = Awaited<ReturnType<typeof getDealsPageData>>["deals"][number];

function DealTable({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="py-2">Off</th>
            <th>Card</th>
            <th>Set</th>
            <th className="text-right">Listed</th>
            <th className="text-right">Worth</th>
            <th className="text-right" title="After shipping">
              Save
            </th>
            <th>Seller</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.listingId} className="border-t border-zinc-800">
              <td className="py-2 font-semibold text-emerald-400">
                {Math.round(d.discount * 100)}%
              </td>
              <td className="py-2">
                <a
                  href={d.tcgplayerUrl}
                  className="hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {d.name}
                </a>
                <span className="ml-2 text-xs text-zinc-500">
                  {d.finish}
                  {d.rarity ? ` · ${d.rarity}` : ""}
                  {d.quantity > 1 ? ` · x${d.quantity}` : ""}
                </span>
              </td>
              <td className="text-zinc-400">{d.setName}</td>
              <td className="text-right">
                {money(d.listingPrice)}
                {d.shippingPrice > 0 && (
                  <span className="ml-1 text-xs text-zinc-500">
                    +{money(d.shippingPrice)}
                  </span>
                )}
              </td>
              <td className="text-right text-zinc-400">
                {money(d.benchmarkPrice)}
                {/* Say which benchmark this is measured against — a deal against
                    a fallback market estimate is weaker evidence than one
                    against real sales, and the reader deserves to know. */}
                <span
                  className="ml-1 text-xs"
                  title={
                    d.benchmarkSource === "sales"
                      ? `median of ${d.sampleSize} recent sales`
                      : "TCGplayer market price (too few recent sales)"
                  }
                >
                  {d.benchmarkSource === "sales" ? (
                    <span className="text-zinc-600">n={d.sampleSize}</span>
                  ) : (
                    <span className="text-amber-600/70">est.</span>
                  )}
                </span>
              </td>
              <td className="text-right">
                {/* Net of shipping — the amount you actually gain. Listings
                    where postage eats the saving are excluded upstream. */}
                {money(d.netSavings)}
              </td>
              <td className="text-zinc-400">
                {d.sellerName ?? "—"}
                {d.sellerRating != null && (
                  <span className="ml-1 text-xs text-zinc-600">
                    {(d.sellerRating * 100).toFixed(0)}%
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
