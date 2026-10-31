import { CONTROL_CODE, encodeCode, newAnonId } from "@next-evolve/protocol";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { type EvolveConfig, normalizePath, resolveConfig } from "../config/config";
import { assign } from "../core/assign";
import { createBotDetector } from "../core/bots";
import { HEADER_CODE, HEADER_PATH } from "../core/constants";
import {
  ANON_COOKIE,
  ASSIGN_COOKIE,
  parseAssignments,
  serializeAssignments,
} from "../core/cookies";
import { logRateLimited } from "../core/log";
import { getBundleStore, type RuntimeOptions } from "../store/runtime";

export type EvolveProxyOptions = RuntimeOptions & {
  /** Random source in [0, 1) (tests). */
  random?: () => number;
};

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
    let setCookies: [string, string][] = [];
    if (bundle && !isBot(req.headers.get("user-agent")) && cfg.consent?.(req) !== false) {
      const cookie = parseAssignments(req.cookies.get(ASSIGN_COOKIE)?.value);
      const a = assign(bundle, path, cookie, opts.random ?? Math.random);
      code = encodeCode(a.pairs);
      const running = (bundle.routing.routes[path] ?? []).some(
        (e) => bundle.routing.experiments[e]?.status === "running",
      );
      if (running) {
        if (!req.cookies.get(ANON_COOKIE)?.value) setCookies.push([ANON_COOKIE, newAnonId()]);
        if (a.changed) setCookies.push([ASSIGN_COOKIE, serializeAssignments(a.assigned)]);
      }
    }
    res = isStatic ? rewrite(req, code, path) : passThrough(req, code, path);
    if (setCookies.length) {
      const secure =
        (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "")) === "https";
      const maxAge = cfg.cookies.maxAgeDays * 86_400;
      for (const [name, value] of setCookies) {
        res.cookies.set(name, value, {
          path: "/",
          maxAge,
          sameSite: "lax",
          httpOnly: true,
          secure,
          ...(cfg.cookies.domain ? { domain: cfg.cookies.domain } : {}),
        });
      }
      setCookies = [];
    }
  } catch (e) {
    logRateLimited("proxy", "proxy error; serving control", e);
    res = isStatic ? rewrite(req, CONTROL_CODE, path) : passThrough(req, CONTROL_CODE, path);
  }
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
  resolveConfig(config);
  return function proxy(req: NextRequest, event: NextFetchEvent): NextResponse {
    return applyEvolve(config, req, event, opts) ?? NextResponse.next();
  };
}
