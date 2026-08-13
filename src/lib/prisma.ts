import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";

// This wiring is load-bearing on Cloudflare Workers and is copied from the
// RiftboundElo app, where it is proven in production. Don't "simplify" it:
// engineType="client" + an always-on Neon adapter + `.prisma/client` in
// serverExternalPackages + poolQueryViaFetch are what make Prisma work on
// workerd. Reverting any one of them yields engine-not-found / wasm-fs-read /
// intermittent 500s. See DEPLOYMENT.md.
//
// Neon exposes two connection strings:
//   DATABASE_URL        — pooled (PgBouncer), for the app's short-lived queries.
//   DIRECT_DATABASE_URL — direct (non-pooler), for the bulk-write CLI scripts.
const pooled = process.env.DATABASE_URL;
const direct = process.env.DIRECT_DATABASE_URL ?? pooled;

// Which side is running? Cloudflare Workers does NOT populate NEXT_RUNTIME, so
// WebSocketPair/navigator.userAgent is the only reliable signal there. CLI
// scripts (plain `tsx`) match neither and keep the direct connection.
const isWorkers =
  typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined" ||
  (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers");
const isAppServer = isWorkers || Boolean(process.env.NEXT_RUNTIME);

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  // With the query compiler there is no native engine, so everything goes
  // through the Neon driver adapter. Runtime detection only picks the
  // connection string, so a wrong guess still works (just pooled vs direct).
  const connectionString = isAppServer ? pooled : direct;
  if (isAppServer) {
    // Workers can't reuse a WebSocket pool connection across requests (the
    // connection goes bad after the first hit → intermittent 500s). Run each
    // query as a stateless HTTP fetch instead; ideal for read-only app queries.
    neonConfig.poolQueryViaFetch = true;
  }
  const adapter = new PrismaNeon({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
