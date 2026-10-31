import postgres from "postgres";

export type Sql = postgres.Sql;
type Env = Record<string, string | undefined>;

/** True on hosts where each request may run in a fresh, short-lived instance. */
export function isServerless(env: Env = process.env): boolean {
  return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY);
}

/**
 * Opens a connection pool. Prepared statements are off so pooled endpoints
 * (Neon's `-pooler` host, PgBouncer in transaction mode) work.
 */
export function createSql(url: string, opts: { env?: Env; max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? (isServerless(opts.env) ? 1 : 10),
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: "next-evolve" },
  });
}

const POOLS = Symbol.for("next-evolve.sql");
type Pools = Map<string, Sql>;
const pools = (): Pools => {
  const g = globalThis as { [POOLS]?: Pools };
  g[POOLS] ??= new Map();
  return g[POOLS];
};

/**
 * The process-wide pool for the customer DB, created on first use. Null when
 * the URL variable isn't set. The proxy never imports this module.
 */
export function getSql(urlEnv = "EVOLVE_DATABASE_URL", env: Env = process.env): Sql | null {
  const url = env[urlEnv];
  if (!url) return null;
  const all = pools();
  let sql = all.get(url);
  if (!sql) {
    sql = createSql(url, { env });
    all.set(url, sql);
  }
  return sql;
}

/** Closes every pool (tests, CLI). */
export async function closeAllSql(): Promise<void> {
  const all = pools();
  const list = [...all.values()];
  all.clear();
  await Promise.all(list.map((s) => s.end({ timeout: 5 })));
}
