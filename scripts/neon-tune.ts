// Apply this project's cost settings to Neon via the API.
//
//   npm run neon:tune            # show current settings, change nothing
//   npm run neon:tune -- --apply # actually write them
//
// Why this exists rather than a dashboard checklist: Neon's "Compute defaults"
// panel only seeds NEWLY CREATED computes, so clicking it does nothing to the
// compute this project already uses — a trap we already fell into once (see
// COST.md). Encoding the settings here makes them idempotent, reviewable, and
// re-appliable after any compute is recreated.
//
// Needs NEON_API_KEY in .env (Neon Console → Account settings → API keys).

import "dotenv/config";

const API = "https://console.neon.tech/api/v2";

/**
 * Target settings. See COST.md for the reasoning behind each.
 *
 * MIN is the number that matters: it's billed for every minute the database is
 * awake. MAX only caps burst — deliberately low, because a 20 MB database
 * running indexed queries will never need more, and a low ceiling limits the
 * blast radius of a pathological query.
 */
const TARGET = {
  autoscaling_limit_min_cu: 0.25,
  autoscaling_limit_max_cu: 2,
  suspend_timeout_seconds: 300, // scale to zero after 5 min idle (plan minimum)
};

/** 1 day. The whole DB is reproducible from upstream, so paying to retain more
 *  history is waste. PITR storage is billed per GB-month. */
const HISTORY_RETENTION_SECONDS = 86_400;

const key = process.env.NEON_API_KEY;
if (!key) {
  console.error(
    "NEON_API_KEY missing from .env.\n" +
      "Create one at Neon Console → Account settings → API keys, then add:\n" +
      '  NEON_API_KEY="napi_..."',
  );
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${key}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

type Project = { id: string; name: string; history_retention_seconds: number };
type Endpoint = {
  id: string;
  host: string;
  type: string;
  project_id: string;
  autoscaling_limit_min_cu: number;
  autoscaling_limit_max_cu: number;
  suspend_timeout_seconds: number;
};

/**
 * List every project the key can see.
 *
 * Bare `GET /projects` 400s with "org_id is required" for org-scoped accounts,
 * which is now the default for new Neon signups. Fall back to enumerating the
 * key's organizations and listing each one's projects.
 */
async function listProjects(): Promise<Project[]> {
  try {
    const { projects } = await api<{ projects: Project[] }>("/projects");
    if (projects.length) return projects;
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("org_id")) throw err;
  }

  const { organizations } = await api<{ organizations: { id: string; name: string }[] }>(
    "/users/me/organizations",
  );
  const all: Project[] = [];
  for (const org of organizations ?? []) {
    const { projects } = await api<{ projects: Project[] }>(
      `/projects?org_id=${encodeURIComponent(org.id)}`,
    );
    console.log(`  org ${org.name} (${org.id}): ${projects.length} project(s)`);
    all.push(...projects);
  }
  return all;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const projects = await listProjects();
  if (!projects.length) {
    console.error("No Neon projects visible to this API key.");
    process.exit(1);
  }

  // Prefer the project whose endpoint matches DATABASE_URL, so this can't
  // retune the wrong project on an account with several.
  const dbHost = (process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "")
    .replace(/^.*@/, "")
    .replace(/[/?].*$/, "")
    .replace("-pooler", "");

  let target: { project: Project; endpoints: Endpoint[] } | null = null;
  for (const project of projects) {
    const { endpoints } = await api<{ endpoints: Endpoint[] }>(
      `/projects/${project.id}/endpoints`,
    );
    if (!dbHost || endpoints.some((e) => e.host.replace("-pooler", "") === dbHost)) {
      target = { project, endpoints };
      break;
    }
  }
  if (!target) {
    console.error(
      `No project has an endpoint matching ${dbHost}. Projects seen: ` +
        projects.map((p) => p.name).join(", "),
    );
    process.exit(1);
  }

  const { project, endpoints } = target;
  console.log(`project: ${project.name} (${project.id})`);
  console.log(
    `history retention: ${project.history_retention_seconds}s` +
      ` (${(project.history_retention_seconds / 86400).toFixed(2)} days)`,
  );

  for (const e of endpoints) {
    console.log(
      `\nendpoint ${e.id} [${e.type}] ${e.host}\n` +
        `  min_cu=${e.autoscaling_limit_min_cu}  max_cu=${e.autoscaling_limit_max_cu}` +
        `  suspend=${e.suspend_timeout_seconds}s`,
    );
    const drift = Object.entries(TARGET).filter(
      ([k, v]) => (e as unknown as Record<string, number>)[k] !== v,
    );
    if (!drift.length) {
      console.log("  ✓ already matches target");
      continue;
    }
    console.log(
      "  drift: " + drift.map(([k, v]) => `${k}: ${(e as unknown as Record<string, number>)[k]} → ${v}`).join(", "),
    );
    if (!apply) continue;

    const updated = await api<{ endpoint: Endpoint }>(
      `/projects/${project.id}/endpoints/${e.id}`,
      { method: "PATCH", body: JSON.stringify({ endpoint: TARGET }) },
    );
    const u = updated.endpoint;
    console.log(
      `  ✓ updated: min_cu=${u.autoscaling_limit_min_cu} max_cu=${u.autoscaling_limit_max_cu}` +
        ` suspend=${u.suspend_timeout_seconds}s`,
    );
  }

  if (project.history_retention_seconds !== HISTORY_RETENTION_SECONDS) {
    console.log(
      `\nhistory retention drift: ${project.history_retention_seconds}s → ${HISTORY_RETENTION_SECONDS}s`,
    );
    if (apply) {
      const updated = await api<{ project: Project }>(`/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          project: { history_retention_seconds: HISTORY_RETENTION_SECONDS },
        }),
      });
      console.log(`  ✓ updated: ${updated.project.history_retention_seconds}s`);
    }
  } else {
    console.log("\n✓ history retention already matches target");
  }

  if (!apply) console.log("\n(dry run — re-run with `-- --apply` to write)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
