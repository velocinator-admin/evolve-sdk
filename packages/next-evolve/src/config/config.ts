import { compilePattern, isPattern, type RouteTable, routeTable } from "../core/routes";
export type RouteConfig = {
  /** static (default): ISR per variant under `app/[evolve]/`. dynamic: page reads `x-evolve-a`. */
  mode: "static" | "dynamic";
};

export type EvolveConfig = {
  /**
   * Routes Evolve may test, keyed by pathname (e.g. "/", "/pricing") or, since
   * 0.8, a pattern (`/lp/:slug`, `/docs/:path*`). An exact path wins over a pattern.
   */
  routes: Record<string, RouteConfig>;
  store?: "auto" | "memory" | "global-config";
  sync?: { pollSeconds?: number };
  database?: { urlEnv?: string };
  aggregate?: {
    maxMs?: number;
    statementTimeoutMs?: number;
    /**
     * push (default): the cloud calls `/api/evolve/aggregate`. pull: the app
     * polls the cloud every 60 s and posts results back, for servers the cloud
     * can't reach. Pull needs a long-running Node server (`next start`, Docker).
     */
    mode?: "push" | "pull";
  };
  /**
   * Delete local events older than this many days (minimum 30), once a day,
   * from inside aggregate requests. Unset (default): nothing is deleted.
   * Never deletes data a running or paused experiment still needs.
   */
  retentionDays?: number;
  cookies?: { maxAgeDays?: number; domain?: string };
  /** Return false to serve control and set no cookies (e.g. before consent). */
  consent?: (req: Request) => boolean;
  bots?: { extraPatterns?: string[] };
  /**
   * Opt-in CDN fast path for static-mode routes: repeat views skip the proxy
   * (no function invocation). `maxAgeSeconds` (default: the poll interval)
   * bounds how long a pause or rollback can lag for a returning visitor.
   * Needs `evolveRewrites()` in next.config and `evolveMatcher()` in proxy.ts.
   */
  cdnRouting?: boolean | { maxAgeSeconds?: number };
  /**
   * Request header with the visitor's ISO-3166 alpha-2 country, for UTM rules
   * on `country` (default `x-vercel-ip-country`; e.g. `cf-ipcountry` on Cloudflare).
   */
  geoHeader?: string;
  debug?: boolean;
};

export type ResolvedConfig = {
  routes: ReadonlyMap<string, RouteConfig>;
  /** Route lookup for a normalized pathname: exact, then the most specific pattern. */
  route: RouteTable<RouteConfig>;
  store: "auto" | "memory" | "global-config";
  pollSeconds: number;
  databaseUrlEnv: string;
  aggregate: { maxMs: number; statementTimeoutMs: number; mode: "push" | "pull" };
  retentionDays: number | null;
  cookies: { maxAgeDays: number; domain: string | undefined };
  consent: ((req: Request) => boolean) | undefined;
  botPatterns: readonly string[];
  cdnRouting: { maxAgeSeconds: number } | null;
  geoHeader: string;
  debug: boolean;
};

/** Smallest allowed `retentionDays`. */
export const MIN_RETENTION_DAYS = 30;

/** Normalizes a pathname: no trailing slash (except "/"), no empty segments. */
export function normalizePath(p: string): string {
  if (p === "/" || p === "") return "/";
  const s = p.replace(/\/{2,}/g, "/");
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/** Identity helper for `evolve.config.ts` with types and validation. */
export function defineConfig<const C extends EvolveConfig>(config: C): C {
  resolveConfig(config); // throws early on mistakes
  return config;
}

const resolved = new WeakMap<EvolveConfig, ResolvedConfig>();

export function resolveConfig(config: EvolveConfig): ResolvedConfig {
  const hit = resolved.get(config);
  if (hit) return hit;
  const routes = new Map<string, RouteConfig>();
  for (const [raw, route] of Object.entries(config.routes)) {
    if (!raw.startsWith("/")) throw new Error(`[evolve] route "${raw}" must start with "/"`);
    const path = normalizePath(raw);
    if (path.split("/")[1]?.startsWith("ev_"))
      throw new Error(`[evolve] route "${raw}" can't start with ev_`);
    if (isPattern(path)) {
      const p = compilePattern(path);
      if (typeof p === "string") throw new Error(`[evolve] route "${raw}": ${p}`);
    } else if (/[[\]*?#:]/.test(path))
      throw new Error(`[evolve] route "${raw}" must be a path or a pattern like /lp/:slug`);
    if (route.mode !== "static" && route.mode !== "dynamic") {
      throw new Error(`[evolve] route "${raw}": mode must be "static" or "dynamic"`);
    }
    routes.set(path, route);
  }
  const dev = process.env.NODE_ENV !== "production";
  const pollSeconds = config.sync?.pollSeconds ?? (dev ? 5 : 60);
  let cdnRouting: ResolvedConfig["cdnRouting"] = null;
  if (config.cdnRouting) {
    const maxAge =
      typeof config.cdnRouting === "object"
        ? (config.cdnRouting.maxAgeSeconds ?? pollSeconds)
        : pollSeconds;
    if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 86_400) {
      throw new Error("[evolve] cdnRouting.maxAgeSeconds must be an integer from 1 to 86400");
    }
    cdnRouting = { maxAgeSeconds: maxAge };
  }
  const aggregateMode = config.aggregate?.mode ?? "push";
  if (aggregateMode !== "push" && aggregateMode !== "pull") {
    throw new Error('[evolve] aggregate.mode must be "push" or "pull"');
  }
  const retentionDays = config.retentionDays ?? null;
  if (
    retentionDays !== null &&
    (!Number.isInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS || retentionDays > 3650)
  ) {
    throw new Error(`[evolve] retentionDays must be an integer from ${MIN_RETENTION_DAYS} to 3650`);
  }
  const geoHeader = (config.geoHeader ?? "x-vercel-ip-country").toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(geoHeader)) {
    throw new Error("[evolve] geoHeader must be a header name like x-vercel-ip-country");
  }
  const r: ResolvedConfig = {
    routes,
    route: routeTable(routes),
    store: config.store ?? "auto",
    pollSeconds,
    databaseUrlEnv: config.database?.urlEnv ?? "EVOLVE_DATABASE_URL",
    aggregate: {
      maxMs: config.aggregate?.maxMs ?? 25_000,
      statementTimeoutMs: config.aggregate?.statementTimeoutMs ?? 20_000,
      mode: aggregateMode,
    },
    retentionDays,
    cookies: { maxAgeDays: config.cookies?.maxAgeDays ?? 365, domain: config.cookies?.domain },
    consent: config.consent,
    botPatterns: config.bots?.extraPatterns ?? [],
    cdnRouting,
    geoHeader,
    debug: config.debug ?? dev,
  };
  resolved.set(config, r);
  return r;
}
