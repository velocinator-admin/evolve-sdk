import { CODE_RE } from "@next-evolve/protocol";
import {
  matchHas,
  prepareDestination,
} from "next/dist/shared/lib/router/utils/prepare-destination";
import {
  unstable_doesMiddlewareMatch as doesProxyMatch,
  getRewrittenUrl,
  isRewrite,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { CDN_CODE_PATTERN, cdnCookieName, evolveMatcher, evolveRewrites } from "./cdn";
import { defineConfig, resolveConfig } from "./config";

const routes = {
  "/": { mode: "static" },
  "/pricing": { mode: "static" },
  "/features": { mode: "dynamic" },
} as const;
const on = defineConfig({ routes, cdnRouting: true });
const off = defineConfig({ routes });

const CODE = "ev_k3j9x2-c1d2e3";
const rootCookie = cdnCookieName("/");

describe("cdnRouting config", () => {
  it("is off by default and defaults maxAge to the poll interval", () => {
    expect(resolveConfig(off).cdnRouting).toBeNull();
    expect(resolveConfig(on).cdnRouting).toEqual({ maxAgeSeconds: resolveConfig(on).pollSeconds });
    expect(
      resolveConfig(defineConfig({ routes, cdnRouting: { maxAgeSeconds: 300 } })).cdnRouting,
    ).toEqual({ maxAgeSeconds: 300 });
  });
  it("rejects a bad maxAge", () => {
    expect(() => defineConfig({ routes, cdnRouting: { maxAgeSeconds: 0 } })).toThrow(
      /maxAgeSeconds/,
    );
    expect(() => defineConfig({ routes, cdnRouting: { maxAgeSeconds: 1.5 } })).toThrow(
      /maxAgeSeconds/,
    );
  });
});

describe("cdnCookieName", () => {
  it("is stable, cookie-safe and per route (normalized)", () => {
    expect(cdnCookieName("/pricing")).toBe(cdnCookieName("/pricing/"));
    expect(cdnCookieName("/")).not.toBe(cdnCookieName("/pricing"));
    expect(rootCookie).toMatch(/^evolve_r_[a-z0-9]+$/);
  });
});

describe("CDN_CODE_PATTERN", () => {
  const re = new RegExp(`^${CDN_CODE_PATTERN}$`);
  it("accepts exactly what CODE_RE accepts", () => {
    for (const c of [
      "ev_0",
      CODE,
      "ev_aaaaaa~bbbbbb",
      "ev_aaaaaa-bbbbbb.cccccc-dddddd.eeeeee~ffffff",
      "ev_aaaaaa-bbbbbb.cccccc-dddddd.eeeeee~ffffff.gggggg-hhhhhh",
      "ev_",
      "ev_0.aaaaaa-bbbbbb",
      "ev_AAAAAA-bbbbbb",
      "../x",
      "ev_aaaaaa-bbbbbb/../x",
    ]) {
      expect(re.test(c), c).toBe(CODE_RE.test(c));
    }
  });
});

describe("evolveMatcher (Next's own matcher semantics)", () => {
  const matches = (url: string, cookies?: Record<string, string>) =>
    doesProxyMatch({ config: { matcher: evolveMatcher(on) as never }, url, cookies });

  it("without cdnRouting it is init's plain list", () => {
    expect(evolveMatcher(off)).toEqual(["/", "/pricing", "/features", "/(ev_.*)"]);
  });
  it("runs the proxy for a first view, skips it with the route cookie", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/", { [rootCookie]: CODE })).toBe(false);
    // Another route's cookie doesn't count.
    expect(matches("/pricing", { [rootCookie]: CODE })).toBe(true);
    expect(matches("/pricing", { [cdnCookieName("/pricing")]: "ev_0" })).toBe(false);
  });
  it("runs it for a malformed route cookie (no rewrite would match: the proxy re-issues it)", () => {
    for (const bad of ["../../etc", "ev_", "EV_0", "ev_0/x", ""])
      expect(matches("/", { [rootCookie]: bad }), bad).toBe(true);
  });
  it("always runs it for previews, dynamic routes and /ev_* paths", () => {
    expect(matches("/?evolve_preview=tok", { [rootCookie]: CODE })).toBe(true);
    expect(matches("/", { [rootCookie]: CODE, evolve_pv: "tok" })).toBe(true);
    expect(matches("/features", { [cdnCookieName("/features")]: CODE })).toBe(true);
    expect(matches("/ev_0")).toBe(true);
    expect(matches(`/${CODE}/pricing`, { [rootCookie]: CODE })).toBe(true);
  });
  it("leaves other paths alone", () => {
    expect(matches("/about")).toBe(false);
  });
});

describe("evolveRewrites (Next's own rewrite semantics)", () => {
  // Next's router code for `has`/`missing` and destinations. (The testing
  // helper unstable_getResponseFromNextConfig drops `has` captures, 16.4.3.)
  const resolve = async (url: string, cookies: Record<string, string> = {}) => {
    const u = new URL(url);
    const query = Object.fromEntries(u.searchParams);
    const req = {
      headers: {
        cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
    };
    for (const r of evolveRewrites(on)) {
      if (r.source !== u.pathname) continue;
      const params = matchHas(req as never, query, r.has as never, r.missing as never);
      if (!params) continue;
      return prepareDestination({
        appendParamsToQuery: false,
        destination: r.destination,
        params,
        query: {},
      }).newUrl;
    }
    return null;
  };

  it("passes Next's config validation", async () => {
    const nextConfig = {
      async rewrites() {
        return { beforeFiles: evolveRewrites(on), afterFiles: [], fallback: [] };
      },
    };
    const res = await unstable_getResponseFromNextConfig({
      url: "https://acme.test/about",
      nextConfig,
    });
    expect(isRewrite(res)).toBe(false);
    expect(getRewrittenUrl(res)).toBeNull();
  });

  it("is empty without cdnRouting, and covers static routes only", () => {
    expect(evolveRewrites(off)).toEqual([]);
    expect(evolveRewrites(on).map((r) => r.source)).toEqual(["/", "/pricing"]);
  });
  it("rewrites a returning view to its cached variant page", async () => {
    expect(await resolve("https://acme.test/", { [rootCookie]: CODE })).toBe(`/${CODE}`);
    expect(
      await resolve("https://acme.test/pricing", { [cdnCookieName("/pricing")]: "ev_0" }),
    ).toBe("/ev_0/pricing");
  });
  it("ignores a missing, forged or malformed cookie, and previews", async () => {
    expect(await resolve("https://acme.test/")).toBeNull();
    expect(await resolve("https://acme.test/", { [rootCookie]: "../../etc" })).toBeNull();
    expect(await resolve("https://acme.test/", { [rootCookie]: "ev_" })).toBeNull();
    expect(await resolve("https://acme.test/?evolve_preview=x", { [rootCookie]: CODE })).toBeNull();
    expect(await resolve("https://acme.test/", { [rootCookie]: CODE, evolve_pv: "x" })).toBeNull();
  });
});
