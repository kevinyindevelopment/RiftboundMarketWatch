import Link from "next/link";
import { getMenuStats } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Entry = {
  href: string;
  title: string;
  description: string;
  ready: boolean;
};

const ENTRIES: Entry[] = [
  {
    href: "/deals",
    title: "Deals Tracker",
    description:
      "Live TCGplayer listings priced at least 20% below what the card actually sells for.",
    ready: true,
  },
  {
    href: "/box-ev",
    title: "Box EV",
    description:
      "What a sealed booster box returns on worst-case pull rates, priced against real sales.",
    ready: true,
  },
  {
    href: "/cards",
    title: "Card Browser",
    description: "Every card with current prices, filterable by set, rarity and domain.",
    ready: false,
  },
  {
    href: "/movers",
    title: "Price Movers",
    description: "Biggest gainers and fallers across the last 7 and 30 days.",
    ready: false,
  },
  {
    href: "/sealed",
    title: "Sealed Product",
    description: "Booster boxes, cases and bundles — pricing and trends.",
    ready: false,
  },
];

export default async function Home() {
  let stats: Awaited<ReturnType<typeof getMenuStats>> | null = null;
  try {
    stats = await getMenuStats();
  } catch {
    // An unreachable database shouldn't blank the menu — the links still work.
  }

  return (
    <main className="space-y-10">
      <header>
        <h1 className="text-3xl font-bold">Riftbound Market Watch</h1>
        <p className="mt-2 text-zinc-400">
          Prices from completed TCGplayer sales, refreshed hourly.
        </p>
        {stats && (
          <p className="mt-1 text-sm text-zinc-500">
            {stats.products.toLocaleString()} products ·{" "}
            {stats.sales.toLocaleString()} recorded sales ·{" "}
            {stats.listings.toLocaleString()} live listings tracked
          </p>
        )}
      </header>

      <nav className="grid gap-4 sm:grid-cols-2">
        {ENTRIES.map((e) =>
          e.ready ? (
            <Link
              key={e.href}
              href={e.href}
              className="group rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 transition hover:border-emerald-700 hover:bg-zinc-900"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold group-hover:text-emerald-400">
                  {e.title}
                </h2>
                {e.href === "/deals" && stats && (
                  <span className="rounded bg-emerald-950 px-2 py-0.5 text-xs text-emerald-400">
                    {stats.deals} live
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-zinc-400">{e.description}</p>
            </Link>
          ) : (
            <div
              key={e.href}
              className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-5 opacity-50"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-zinc-400">{e.title}</h2>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-500">
                  soon
                </span>
              </div>
              <p className="mt-1 text-sm text-zinc-500">{e.description}</p>
            </div>
          ),
        )}
      </nav>
    </main>
  );
}
