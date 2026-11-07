// Route patterns (D77): `routes` keys in evolve.config.ts and in the bundle may
// be Next-style patterns (`/lp/:slug`, `/docs/:path*`, `/docs/:path+`).
// Compiled once; an exact path wins over a pattern, then the most specific
// pattern (fewest params, then the longest static prefix).

const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)([*+])?$/;
const LITERAL = /^[^:[\]*?#()]+$/;

export type RoutePattern = {
  key: string;
  re: RegExp;
  params: number;
  /** Characters before the first param (more = more specific). */
  prefix: number;
  /** Ends in a catch-all (`*` / `+`). */
  rest: boolean;
};

/** Whether a route key is a pattern (has a `:param` segment). */
export const isPattern = (key: string): boolean => key.includes("/:");

/**
 * Compiles a pattern key, or explains why it isn't one. `:name` matches one
 * segment; `:name*` (zero or more) and `:name+` (one or more) only at the end.
 */
export function compilePattern(key: string): RoutePattern | string {
  const segs = key.split("/").slice(1);
  let re = "^";
  let params = 0;
  let prefix = -1;
  let rest = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const m = PARAM.exec(s);
    if (!m) {
      if (!LITERAL.test(s)) return `segment "${s}" must be a literal or :param`;
      re += `/${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
      continue;
    }
    if (prefix < 0) prefix = segs.slice(0, i).reduce((n, x) => n + x.length + 1, 0);
    params++;
    if (m[2]) {
      if (i !== segs.length - 1) return `:${m[1]}${m[2]} must be the last segment`;
      rest = true;
      re += m[2] === "*" ? "(?:/[^/]+)*" : "(?:/[^/]+)+";
    } else re += "/[^/]+";
  }
  if (params === 0) return "not a pattern";
  return { key, re: new RegExp(`${re}$`), params, prefix, rest };
}

/** Most specific first: fewest params, then longest static prefix, then no catch-all, then key. */
function bySpecificity(a: RoutePattern, b: RoutePattern): number {
  return (
    a.params - b.params ||
    b.prefix - a.prefix ||
    Number(a.rest) - Number(b.rest) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

export type RouteTable<T> = {
  /** The route key and value for a normalized path: exact first, then patterns. */
  match(path: string): { key: string; value: T } | null;
};

/**
 * A lookup table over route keys. Patterns that don't compile are left out
 * (config validation rejects them earlier; a bundle route that isn't valid
 * never matches, as for older SDKs).
 */
export function routeTable<T>(entries: Iterable<[string, T]>): RouteTable<T> {
  const exact = new Map<string, T>();
  const patterns: (RoutePattern & { value: T })[] = [];
  for (const [key, value] of entries) {
    if (!isPattern(key)) {
      exact.set(key, value);
      continue;
    }
    const p = compilePattern(key);
    if (typeof p !== "string") patterns.push({ ...p, value });
  }
  patterns.sort(bySpecificity);
  return {
    match(path) {
      const hit = exact.get(path);
      if (hit !== undefined) return { key: path, value: hit };
      for (const p of patterns) if (p.re.test(path)) return { key: p.key, value: p.value };
      return null;
    },
  };
}

const bundleTables = new WeakMap<object, RouteTable<string[]>>();

/** The bundle's `routing.routes` as a table, compiled once per bundle object. */
export function bundleRoutes(bundle: {
  routing: { routes: Record<string, string[]> };
}): RouteTable<string[]> {
  let t = bundleTables.get(bundle);
  if (!t) {
    t = routeTable(Object.entries(bundle.routing.routes));
    bundleTables.set(bundle, t);
  }
  return t;
}

/** App Router folder for a route key: `/lp/:slug` → `lp/[slug]`, `:p*` → `[[...p]]`, `:p+` → `[...p]`. */
export function routeDir(key: string): string {
  return key
    .split("/")
    .slice(1)
    .map((s) => {
      const m = PARAM.exec(s);
      if (!m) return s;
      return m[2] === "*" ? `[[...${m[1]}]]` : m[2] === "+" ? `[...${m[1]}]` : `[${m[1]}]`;
    })
    .join("/");
}
