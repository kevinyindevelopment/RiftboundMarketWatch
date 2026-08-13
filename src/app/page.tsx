import { getHomeData } from "@/lib/queries";

// Still dynamic per request — but the DATA behind it is edge-cached for an hour
// (see src/lib/cache.ts), so a request is cheap React rendering rather than five
// Neon queries. Rendering dynamically keeps deploys free of a build-time
// database dependency; the cache is what protects the cost.
export const dynamic = "force-dynamic";

function money(n: number | null) {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function Home() {
  // An unconfigured or empty database is the expected first-run state, not a
  // crash: show what's missing instead of a 500.
  let data;
  try {
    data = await getHomeData();
  } catch (err) {
    return (
      <main>
        <h1 className="text-3xl font-bold">Riftbound Market Watch</h1>
        <p className="mt-4 text-zinc-400">
          No database yet. Set <code className="text-zinc-200">DATABASE_URL</code> and{" "}
          <code className="text-zinc-200">DIRECT_DATABASE_URL</code>, run{" "}
          <code className="text-zinc-200">npm run db:push</code>, then{" "}
          <code className="text-zinc-200">npm run ingest</code>.
        </p>
        <pre className="mt-6 overflow-x-auto rounded bg-zinc-900 p-4 text-xs text-red-300">
          {err instanceof Error ? err.message : String(err)}
        </pre>
      </main>
    );
  }

  const { summary, topSingles, topSealed, movers, salesStats } = data;

  return (
    <main className="space-y-12">
      <header>
        <h1 className="text-3xl font-bold">Riftbound Market Watch</h1>
        <p className="mt-2 text-zinc-400">
          {summary.singles.toLocaleString()} cards and {summary.sealed} sealed products
          across {summary.sets} sets · {summary.days} day
          {summary.days === 1 ? "" : "s"} of price history
          {summary.latest ? ` · latest ${summary.latest}` : ""}
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Prices are the median of the last 10 completed TCGplayer sales (Near
          Mint), refreshed hourly ·{" "}
          <strong className="text-zinc-400">
            {salesStats.priced.toLocaleString()}/{salesStats.total.toLocaleString()}
          </strong>{" "}
          priced from {salesStats.sales.toLocaleString()} recorded sales
        </p>
      </header>

      <Section title="Most valuable cards">
        <PriceTable rows={topSingles} />
      </Section>

      <Section title="Most valuable sealed">
        <PriceTable rows={topSealed} />
      </Section>

      <Section
        title="Biggest movers"
        empty={
          movers.length === 0
            ? "Needs at least two days of price history — check back after the next update."
            : undefined
        }
      >
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-2">Card</th>
              <th>Set</th>
              <th className="text-right">Was</th>
              <th className="text-right">Now</th>
              <th className="text-right">Change</th>
            </tr>
          </thead>
          <tbody>
            {movers.map((m) => (
              <tr key={`${m.productId}-${m.subTypeName}`} className="border-t border-zinc-800">
                <td className="py-2">
                  <a href={m.tcgplayerUrl} className="hover:underline" target="_blank" rel="noreferrer">
                    {m.name}
                  </a>
                  <span className="ml-2 text-xs text-zinc-500">{m.subTypeName}</span>
                </td>
                <td className="text-zinc-400">{m.setName}</td>
                <td className="text-right text-zinc-400">{money(m.previousPrice)}</td>
                <td className="text-right">{money(m.marketPrice)}</td>
                <td
                  className={`text-right ${m.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}
                >
                  {m.changePct >= 0 ? "+" : ""}
                  {m.changePct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty?: string;
}) {
  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      {empty ? <p className="text-zinc-500">{empty}</p> : children}
    </section>
  );
}

type ValuedRow = {
  productId: number;
  name: string;
  setName: string;
  rarity: string | null;
  tcgplayerUrl: string;
  price: number;
  source: "sales" | "market";
  sampleSize: number | null;
  lastSaleAt: string | null;
};

function PriceTable({ rows }: { rows: ValuedRow[] }) {
  if (rows.length === 0) return <p className="text-zinc-500">No price data yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-zinc-500">
        <tr>
          <th className="py-2">Name</th>
          <th>Set</th>
          <th>Rarity</th>
          <th className="text-right">Price</th>
          <th className="text-right">Based on</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.productId} className="border-t border-zinc-800">
            <td className="py-2">
              <a href={r.tcgplayerUrl} className="hover:underline" target="_blank" rel="noreferrer">
                {r.name}
              </a>
            </td>
            <td className="text-zinc-400">{r.setName}</td>
            <td className="text-zinc-400">{r.rarity ?? "—"}</td>
            <td className="text-right">{money(r.price)}</td>
            <td className="text-right text-xs">
              {/* Never let a fallback market price look like a sales-derived one:
                  the whole value of this site is knowing which you're reading. */}
              {r.source === "sales" ? (
                <span className="text-emerald-400">
                  {r.sampleSize} sale{r.sampleSize === 1 ? "" : "s"}
                </span>
              ) : (
                <span className="text-zinc-500" title="Too few recent sales — showing TCGplayer market price">
                  market est.
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
