export type RouteConfig = {
  /** static (default): ISR per variant under `app/[evolve]/`. dynamic: page reads `x-evolve-a`. */
  mode: "static" | "dynamic";
};

export type EvolveConfig = {
  /** Routes Evolve may test, keyed by exact pathname (e.g. "/", "/pricing"). */
  routes: Record<string, RouteConfig>;
  store?: "auto" | "memory" | "global-config";
  sync?: { pollSeconds?: number };
  database?: { urlEnv?: string };
  aggregate?: { maxMs?: number; statementTimeoutMs?: number };
  cookies?: { maxAgeDays?: number; domain?: string };
  /** Return false to serve control and set no cookies (e.g. before consent). */
  consent?: (req: Request) => boolean;
  bots?: { extraPatterns?: string[] };
  debug?: boolean;
};

export type ResolvedConfig = {
  routes: ReadonlyMap<string, RouteConfig>;
  store: "auto" | "memory" | "global-config";
  pollSeconds: number;
  databaseUrlEnv: string;
  aggregate: { maxMs: number; statementTimeoutMs: number };
  cookies: { maxAgeDays: number; domain: string | undefined };
  consent: ((req: Request) => boolean) | undefined;
  botPatterns: readonly string[];
  debug: boolean;
};

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
    if (/[[\]*?#]/.test(path)) throw new Error(`[evolve] route "${raw}" must be a concrete path`);
    if (route.mode !== "static" && route.mode !== "dynamic") {
      throw new Error(`[evolve] route "${raw}": mode must be "static" or "dynamic"`);
    }
    routes.set(path, route);
  }
  const dev = process.env.NODE_ENV !== "production";
  const r: ResolvedConfig = {
    routes,
    store: config.store ?? "auto",
    pollSeconds: config.sync?.pollSeconds ?? (dev ? 5 : 60),
    databaseUrlEnv: config.database?.urlEnv ?? "EVOLVE_DATABASE_URL",
    aggregate: {
      maxMs: config.aggregate?.maxMs ?? 25_000,
      statementTimeoutMs: config.aggregate?.statementTimeoutMs ?? 20_000,
    },
    cookies: { maxAgeDays: config.cookies?.maxAgeDays ?? 365, domain: config.cookies?.domain },
    consent: config.consent,
    botPatterns: config.bots?.extraPatterns ?? [],
    debug: config.debug ?? dev,
  };
  resolved.set(config, r);
  return r;
}
