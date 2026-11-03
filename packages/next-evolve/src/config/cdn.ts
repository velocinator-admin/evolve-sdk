// CDN routing (opt-in, static-mode routes only): after the proxy has routed a
// visitor once, it sets a short-lived per-route cookie holding the variant
// code. A `next.config` rewrite keyed on that cookie then serves `/<code>/…`
// straight from the CDN, and the proxy matcher skips requests that carry it.
// On Vercel, invoking any proxy costs ~18 ms TTFB (even a no-op one; see
// docs/perf/proxy-overhead.md), so repeat views within the cookie's lifetime
// pay nothing. The cookie expires after `maxAgeSeconds` (default: the poll
// interval), which bounds how long a paused or rolled-back experiment can
// still be served from the CDN, the same bound polling already gives.
import { type EvolveConfig, normalizePath, resolveConfig } from "./config";

/** Preview cookie and query parameter (mirrors core/cookies + proxy, kept here so next.config imports stay tiny). */
const PREVIEW_COOKIE = "evolve_pv";
const PREVIEW_PARAM = "evolve_preview";

/** Variant code as it may appear in the cookie; same shape as the protocol's CODE_RE (≤ 3 pairs). */
export const CDN_CODE_PATTERN =
  "ev_(?:0|[a-z0-9]{6}[-~][a-z0-9]{6}(?:\\.[a-z0-9]{6}[-~][a-z0-9]{6}){0,2})";

/** FNV-1a 32-bit, base36: a short, stable, cookie-safe name per route. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Cookie holding the CDN-routed code for one route, e.g. `evolve_r_1lqbzmx`. */
export const cdnCookieName = (path: string) => `evolve_r_${hash(normalizePath(path))}`;

type Has =
  | { type: "cookie"; key: string; value?: string }
  | { type: "query"; key: string; value?: string };

/** Routes that take the CDN fast path: static mode, with `cdnRouting` on. */
function cdnRoutes(config: EvolveConfig): string[] {
  const cfg = resolveConfig(config);
  if (!cfg.cdnRouting) return [];
  return [...cfg.routes].filter(([, r]) => r.mode === "static").map(([p]) => p);
}

const previewMissing: Has[] = [
  { type: "cookie", key: PREVIEW_COOKIE },
  { type: "query", key: PREVIEW_PARAM },
];

/**
 * `beforeFiles` rewrites for `next.config`: a request for a CDN-routed path
 * that carries its route cookie (and no preview) goes straight to the cached
 * variant page. Empty without `cdnRouting`.
 *
 *   async rewrites() { return { beforeFiles: evolveRewrites(evolveConfig), afterFiles: [], fallback: [] } }
 */
export function evolveRewrites(
  config: EvolveConfig,
): { source: string; destination: string; has: Has[]; missing: Has[] }[] {
  return cdnRoutes(config).map((path) => ({
    source: path,
    has: [{ type: "cookie", key: cdnCookieName(path), value: `(?<code>${CDN_CODE_PATTERN})` }],
    missing: previewMissing,
    destination: path === "/" ? "/:code" : `/:code${path}`,
  }));
}

export type MatcherEntry = string | { source: string; has?: Has[]; missing?: Has[] };

/**
 * The proxy matcher for these routes. Next needs `config.matcher` as a literal
 * in `proxy.ts`, so `init` writes this array out (and `doctor` compares it).
 * A CDN-routed path runs the proxy only without its route cookie, or for a
 * preview.
 */
export function evolveMatcher(config: EvolveConfig): MatcherEntry[] {
  const cfg = resolveConfig(config);
  const cdn = new Set(cdnRoutes(config));
  const out: MatcherEntry[] = [];
  for (const path of cfg.routes.keys()) {
    if (!cdn.has(path)) {
      out.push(path);
      continue;
    }
    out.push(
      { source: path, missing: [{ type: "cookie", key: cdnCookieName(path) }] },
      { source: path, has: [{ type: "cookie", key: PREVIEW_COOKIE }] },
      { source: path, has: [{ type: "query", key: PREVIEW_PARAM }] },
    );
  }
  out.push("/(ev_.*)");
  return out;
}
