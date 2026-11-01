// Vercel Global Config store (spec §7.8, formerly Edge Config). The sync route
// writes the latest signed bundle to one item; every instance reads it (memory
// TTL 10 s), so a publish reaches all instances in ~10 s instead of ≤ 60 s.
// Tokens read from Global Config are verified like any other bundle.
import type { FetchBundleResult } from "./fetch";

type Env = Record<string, string | undefined>;

/** How often instances re-read Global Config. */
export const GLOBAL_CONFIG_TTL_MS = 10_000;
/** Max wait for the first read on a cold start; then the build bundle serves. */
export const COLD_READ_CAP_MS = 20;

export const globalConfigItemKey = (site: string): string => `evolve_bundle_${site}`;

export type GlobalConfigSettings = {
  connectionString: string;
  /** Write access (sync route only). */
  id?: string;
  apiToken?: string;
  teamId?: string;
};

/**
 * Global Config settings when the app opted in: `store: "global-config"`, or
 * `"auto"` with `EVOLVE_GLOBAL_CONFIG` (connection string) set.
 */
export function globalConfigSettings(
  store: "auto" | "memory" | "global-config" | undefined,
  env: Env,
): GlobalConfigSettings | null {
  if (store === "memory") return null;
  const connectionString = env.EVOLVE_GLOBAL_CONFIG;
  if (!connectionString) {
    if (store === "global-config") {
      console.error('[evolve] store: "global-config" needs EVOLVE_GLOBAL_CONFIG; using memory');
    }
    return null;
  }
  return {
    connectionString,
    id: env.EVOLVE_GLOBAL_CONFIG_ID,
    apiToken: env.EVOLVE_VERCEL_API_TOKEN,
    teamId: env.EVOLVE_VERCEL_TEAM_ID,
  };
}

export type GlobalConfigReader = (key: string) => Promise<unknown>;

export function defaultReader(connectionString: string): GlobalConfigReader {
  let client: Promise<{ get: (k: string) => Promise<unknown> }> | null = null;
  return async (key) => {
    client ??= import("@vercel/global-config").then((m) => m.createClient(connectionString));
    return (await client).get(key);
  };
}

/** `"<ver>.<iat>"` of a token, without verifying it (verification is the store's job). */
function versionOf(token: string): { ver: number; iat: number } | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof p.ver === "number" && typeof p.iat === "number" ? p : null;
  } catch {
    return null;
  }
}
const newer = (a: string, b: string) => {
  const x = versionOf(a);
  const y = versionOf(b);
  if (!x) return b;
  if (!y) return a;
  return x.ver > y.ver || (x.ver === y.ver && x.iat >= y.iat) ? a : b;
};

/**
 * Fetcher for the memory store: reads Global Config every call; also asks the
 * cloud when Global Config is empty or every `cloudEveryMs` (so a missed
 * webhook or a stale item can't freeze the app), and returns the newer token.
 */
export function createGlobalConfigFetcher(opts: {
  site: string;
  read: GlobalConfigReader;
  cloud?: (etag: string | null) => Promise<FetchBundleResult>;
  cloudEveryMs: number;
  now?: () => number;
}): (etag: string | null) => Promise<FetchBundleResult> {
  const now = opts.now ?? Date.now;
  const key = globalConfigItemKey(opts.site);
  let lastCloud = -Infinity;
  return async (etag) => {
    let fromConfig: string | null = null;
    try {
      const v = await opts.read(key);
      fromConfig = typeof v === "string" && v ? v : null;
    } catch (e) {
      if (!opts.cloud) return { status: "error", code: "network", message: String(e) };
    }
    let fromCloud: string | null = null;
    if (opts.cloud && (!fromConfig || now() - lastCloud >= opts.cloudEveryMs)) {
      lastCloud = now();
      const r = await opts.cloud(fromConfig ? null : etag);
      if (r.status === "ok") fromCloud = r.token;
      else if (!fromConfig) return r;
    }
    const best = fromConfig && fromCloud ? newer(fromConfig, fromCloud) : (fromConfig ?? fromCloud);
    if (!best) return { status: "not_modified" };
    const v = versionOf(best);
    if (v && etag === `"${v.ver}.${v.iat}"`) return { status: "not_modified" };
    return { status: "ok", token: best, etag: null };
  };
}

/**
 * Writes the token to the site's item via the Vercel REST API (sync route).
 * Never throws; returns whether the write succeeded.
 */
export async function writeGlobalConfig(
  settings: GlobalConfigSettings,
  site: string,
  token: string,
  f: typeof fetch = fetch,
): Promise<boolean> {
  if (!settings.id || !settings.apiToken) {
    console.error(
      "[evolve] Global Config is read-only here: set EVOLVE_GLOBAL_CONFIG_ID and EVOLVE_VERCEL_API_TOKEN",
    );
    return false;
  }
  const url = new URL(`https://api.vercel.com/v1/edge-config/${settings.id}/items`);
  if (settings.teamId) url.searchParams.set("teamId", settings.teamId);
  try {
    const res = await f(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${settings.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        items: [{ operation: "upsert", key: globalConfigItemKey(site), value: token }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[evolve] Global Config write failed (${res.status})`, body.slice(0, 200));
    }
    return res.ok;
  } catch (e) {
    console.error("[evolve] Global Config write failed", e);
    return false;
  }
}
