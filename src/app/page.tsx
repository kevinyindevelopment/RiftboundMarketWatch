import { getSummary, getTopByMarketPrice, getTopMovers } from "@/lib/queries";

// Prices change daily and the DB is written out-of-band by the ingest job, so
// there is nothing to prerender — always render against live Neon data.
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
    const [summary, topSingles, topSealed, movers] = await Promise.all([
      getSummary(),
      getTopByMarketPrice({ limit: 20, sealed: false }),
      getTopByMarketPrice({ limit: 10, sealed: true }),
      getTopMovers({ limit: 20 }),
    ]);
    data = { summary, topSingles, topSealed, movers };
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

  const { summary, topSingles, topSealed, movers } = data;

  return (
    <main className="space-y-12">
      <header>
        <h1 className="text-3xl font-bold">Riftbound Market Watch</h1>
        <p className="mt-2 text-zinc-400">
          {summary.singles.toLocaleString()} cards and {summary.sealed} sealed products
          across {summary.sets} sets · {summary.days} day
          {summary.days === 1 ? "" : "s"} of price history
          {summary.latest
            ? ` · latest ${summary.latest.toISOString().slice(0, 10)}`
            : ""}
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

function PriceTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getTopByMarketPrice>>;
}) {
  if (rows.length === 0) return <p className="text-zinc-500">No price data yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-zinc-500">
        <tr>
          <th className="py-2">Name</th>
          <th>Set</th>
          <th>Rarity</th>
          <th className="text-right">Market</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.productId}-${r.subTypeName}`} className="border-t border-zinc-800">
            <td className="py-2">
              <a href={r.tcgplayerUrl} className="hover:underline" target="_blank" rel="noreferrer">
                {r.name}
              </a>
              <span className="ml-2 text-xs text-zinc-500">{r.subTypeName}</span>
            </td>
            <td className="text-zinc-400">{r.setName}</td>
            <td className="text-zinc-400">{r.rarity ?? "—"}</td>
            <td className="text-right">{money(r.marketPrice)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
