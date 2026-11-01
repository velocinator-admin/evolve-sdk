import { CONTROL_CODE, encodeCode, newAnonId, verifyPreview } from "@next-evolve/protocol";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { type EvolveConfig, normalizePath, resolveConfig } from "../config/config";
import { assign, visitorDraw } from "../core/assign";
import { createBotDetector } from "../core/bots";
import { HEADER_CODE, HEADER_PATH } from "../core/constants";
import {
  ANON_COOKIE,
  ASSIGN_COOKIE,
  PREVIEW_COOKIE,
  parseAssignments,
  serializeAssignments,
} from "../core/cookies";
import { logRateLimited } from "../core/log";
import { coldStart, getBundleStore, getSiteIdentity, type RuntimeOptions } from "../store/runtime";

export type EvolveProxyOptions = RuntimeOptions & {
  /** Random source in [0, 1) (tests). */
  random?: () => number;
};

/** Query parameter carrying a preview token from the dashboard. */
export const PREVIEW_PARAM = "evolve_preview";

const detectors = new WeakMap<EvolveConfig, (ua: string | null) => boolean>();

/**
 * Runs Evolve for one request. Returns a response for Evolve routes and
 * `/ev_*` paths, or null for everything else (so it composes with an existing
 * proxy: `return applyEvolve(config, req, event) ?? NextResponse.next()`).
 * Never throws and never makes a network call on the request path.
 */
export function applyEvolve(
  config: EvolveConfig,
  req: NextRequest,
  event?: Pick<NextFetchEvent, "waitUntil">,
  opts: EvolveProxyOptions = {},
): NextResponse | null {
  const t0 = performance.now();
  const pathname = req.nextUrl.pathname;
  // Variant paths are internal rewrite targets; never serve them directly.
  if (pathname.split("/")[1]?.startsWith("ev_")) return new NextResponse(null, { status: 404 });

  let cfg: ReturnType<typeof resolveConfig>;
  try {
    cfg = resolveConfig(config);
  } catch (e) {
    logRateLimited("config", "invalid evolve config", e);
    return null;
  }
  const path = normalizePath(pathname);
  const route = cfg.routes.get(path);
  if (!route) return null;
  const isStatic = route.mode === "static";

  let res: NextResponse;
  try {
    let isBot = detectors.get(config);
    if (!isBot) {
      isBot = createBotDetector(cfg.botPatterns);
      detectors.set(config, isBot);
    }
    const bundle =
      getBundleStore(cfg, opts)?.peek(event ? (p) => event.waitUntil(p) : undefined) ?? null;

    let code = CONTROL_CODE;
    const setCookies: [name: string, value: string, session?: boolean][] = [];

    // Preview links: a signed token forces a code; nothing is assigned or counted.
    const fromQuery = req.nextUrl.searchParams.get(PREVIEW_PARAM);
    const previewToken = fromQuery ?? req.cookies.get(PREVIEW_COOKIE)?.value;
    const identity = previewToken ? getSiteIdentity(opts) : null;
    const preview = previewToken && identity ? verifyPreview(previewToken, identity) : null;

    if (preview) {
      code = preview.code;
      if (fromQuery) setCookies.push([PREVIEW_COOKIE, fromQuery, true]);
    } else if (bundle && !isBot(req.headers.get("user-agent")) && cfg.consent?.(req) !== false) {
      const cookie = parseAssignments(req.cookies.get(ASSIGN_COOKIE)?.value);
      const known = req.cookies.get(ANON_COOKIE)?.value;
      const anon = known || newAnonId();
      const a = assign(bundle, path, cookie, opts.random ?? visitorDraw(anon));
      code = encodeCode(a.pairs);
      const running = (bundle.routing.routes[path] ?? []).some(
        (e) => bundle.routing.experiments[e]?.status === "running",
      );
      if (running) {
        if (!known) setCookies.push([ANON_COOKIE, anon]);
        if (a.changed) setCookies.push([ASSIGN_COOKIE, serializeAssignments(a.assigned)]);
      }
    }
    res = isStatic ? rewrite(req, code, path) : passThrough(req, code, path);
    if (setCookies.length) {
      const secure =
        (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "")) === "https";
      const maxAge = cfg.cookies.maxAgeDays * 86_400;
      for (const [name, value, session] of setCookies) {
        res.cookies.set(name, value, {
          path: "/",
          ...(session ? {} : { maxAge }),
          sameSite: "lax",
          httpOnly: true,
          secure,
          ...(cfg.cookies.domain ? { domain: cfg.cookies.domain } : {}),
        });
      }
    }
  } catch (e) {
    logRateLimited("proxy", "proxy error; serving control", e);
    res = isStatic ? rewrite(req, CONTROL_CODE, path) : passThrough(req, CONTROL_CODE, path);
  }
  // Off Vercel, a shared CDN in front of the app could cache one visitor's
  // variant for everyone. Vercel's cache keys on the rewritten path.
  if ((opts.env ?? process.env).VERCEL !== "1")
    res.headers.set("cache-control", "private, no-store");
  res.headers.set("server-timing", `evolve;dur=${(performance.now() - t0).toFixed(3)}`);
  return res;
}

function rewrite(req: NextRequest, code: string, path: string): NextResponse {
  const target = path === "/" ? `/${code}` : `/${code}${path}`;
  return NextResponse.rewrite(new URL(target + req.nextUrl.search, req.url));
}

function passThrough(req: NextRequest, code: string, path: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(HEADER_CODE, code);
  headers.set(HEADER_PATH, path);
  return NextResponse.next({ request: { headers } });
}

/** Builds the `proxy` export for `proxy.ts` (Next 16) or `middleware.ts` (Next 15.5, Node runtime). */
export function createEvolveProxy(config: EvolveConfig, opts: EvolveProxyOptions = {}) {
  resolveConfig(config); // throws on invalid config at startup
  return function proxy(
    req: NextRequest,
    event: NextFetchEvent,
  ): NextResponse | Promise<NextResponse> {
    const ready = evolveReady(config, opts);
    const run = () => applyEvolve(config, req, event, opts) ?? NextResponse.next();
    return ready ? ready.then(run) : run();
  };
}

/**
 * With Global Config, an instance's first request waits ≤ 20 ms for one read
 * (spec §7.8). Returns null when there's nothing to wait for. With an existing
 * proxy: `await evolveReady(config)` before `applyEvolve(...)`.
 */
export function evolveReady(config: EvolveConfig, opts: RuntimeOptions = {}): Promise<void> | null {
  try {
    const store = getBundleStore(resolveConfig(config), opts);
    return store ? coldStart(store) : null;
  } catch {
    return null;
  }
}
