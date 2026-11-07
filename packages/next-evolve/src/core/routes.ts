// Route patterns (D77, TPL-1.1): `routes` keys in evolve.config.ts and in the
// bundle may be Next-style patterns (`/lp/:slug`, `/docs/:path*`,
// `/docs/:path+`, and since 0.9 regex-constrained params like
// `/:name([A-Z][A-Za-z]*-[A-Za-z-]+)`). The grammar, the safety check and the
// linear-time matcher live in @next-evolve/protocol (shared with the cloud).
// Compiled once per bundle; precedence: exact path → constrained pattern →
// unconstrained pattern, then the most specific (fewest params, longest static
// prefix, no catch-all).
import {
  type CompiledRoute,
  compareRoutes,
  compileRoute,
  isRoutePattern,
  parseRouteKey,
  type RouteParams,
} from "@next-evolve/protocol/routes";

export type { RouteParams };

/** Whether a route key is a pattern (has a `:param` segment). */
export const isPattern = isRoutePattern;

/** Compiles a pattern key, or explains why it isn't one. */
export function compilePattern(key: string): CompiledRoute | string {
  return compileRoute(key);
}

export type RouteMatch<T> = { key: string; value: T; params: RouteParams };

export type RouteTable<T> = {
  /** The route key, value and raw params for a normalized path: exact first, then patterns. */
  match(path: string): RouteMatch<T> | null;
};

const NO_PARAMS: RouteParams = Object.freeze({}) as RouteParams;

/**
 * A lookup table over route keys. Patterns that don't compile are left out
 * (config validation rejects them earlier; a bundle route that isn't valid
 * never matches, as for older SDKs).
 */
export function routeTable<T>(entries: Iterable<[string, T]>): RouteTable<T> {
  const exact = new Map<string, T>();
  const patterns: (CompiledRoute & { value: T })[] = [];
  for (const [key, value] of entries) {
    if (!isPattern(key)) {
      exact.set(key, value);
      continue;
    }
    const p = compileRoute(key);
    if (typeof p !== "string") patterns.push(Object.assign(p, { value }));
  }
  patterns.sort(compareRoutes);
  return {
    match(path) {
      const hit = exact.get(path);
      if (hit !== undefined) return { key: path, value: hit, params: NO_PARAMS };
      for (const p of patterns) {
        const params = p.match(path);
        if (params) return { key: p.key, value: p.value, params };
      }
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

/**
 * App Router folder for a route key: `/lp/:slug` → `lp/[slug]`, `:p*` →
 * `[[...p]]`, `:p+` → `[...p]`, `:name(re)` → `[name]` (the proxy checks the constraint).
 */
export function routeDir(key: string): string {
  const segs = isPattern(key) ? parseRouteKey(key) : null;
  if (!segs || typeof segs === "string") return key.split("/").slice(1).join("/");
  return segs
    .map((s) =>
      s.kind === "literal"
        ? s.text
        : s.rest === "*"
          ? `[[...${s.name}]]`
          : s.rest === "+"
            ? `[...${s.name}]`
            : `[${s.name}]`,
    )
    .join("/");
}

/** Decoded string values for `{var}` placeholders (catch-alls joined with `/`). */
export function paramVars(params: RouteParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const raw = Array.isArray(v) ? v.join("/") : v;
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}
