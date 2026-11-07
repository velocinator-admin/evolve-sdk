import { TEST_KEY, TEST_PUBLIC_KEY_ENV, TEST_SECRET_KEY, TEST_SITE } from "@next-evolve/fake-cloud";
import { PREVIEW_TYP } from "@next-evolve/protocol";
import { generateTestKeyPair, signJws } from "@next-evolve/protocol/testing";
// Next 16.4 ships the matcher helper under its old name (docs say unstable_doesProxyMatch).
import {
  unstable_doesMiddlewareMatch as doesProxyMatch,
  getRewrittenUrl,
  isRewrite,
} from "next/experimental/testing/server";
import type { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLEBOT, keys, request, signBundle, storeWith } from "../../test/proxy-helpers";
import { sampleBundle } from "../../test/samples";
import { cdnCookieName } from "../config/cdn";
import { defineConfig, resolveConfig } from "../config/config";
import { createMemoryStore } from "../store/memory";
import { applyEvolve, createEvolveProxy } from "./proxy";

// Shared CI runners are noisy; budgets are checked strictly on dev machines.
const SLACK = process.env.CI ? 3 : 1;

const config = defineConfig({
  routes: {
    "/": { mode: "static" },
    "/pricing": { mode: "static" },
    "/features": { mode: "dynamic" },
  },
});
const event = { waitUntil: vi.fn() };
const fixed = (r: number) => () => r;

const run = (req: ReturnType<typeof request>, store = storeWith(), random = fixed(0.75)) =>
  applyEvolve(config, req, event, { store, random });

const rewritten = (res: NextResponse | null) => {
  expect(res && isRewrite(res)).toBe(true);
  return new URL(getRewrittenUrl(res!)!).pathname + new URL(getRewrittenUrl(res!)!).search;
};

afterEach(() => vi.restoreAllMocks());

describe("proxy (static mode)", () => {
  it("new visitor gets a variant code and both cookies", () => {
    const res = run(request("/"));
    expect(rewritten(res)).toBe("/ev_k3j9x2-c1d2e3");
    expect(res!.cookies.get("evolve_id")?.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res!.cookies.get("evolve_a")?.value).toBe("k3j9x2:c1d2e3");
    const c = res!.cookies.get("evolve_a")!;
    expect(c).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 365 * 86_400,
    });
  });

  it("concurrent first requests of one visitor (prefetch + click) agree on the variant", () => {
    // No random source: the proxy draws from the visitor's evolve_id.
    const b = storeWith((b) => {
      b.routing.experiments.k3j9x2!.variants = [
        { id: "a8f2l1", w: 0.5 },
        { id: "c1d2e3", w: 0.5 },
      ];
    });
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const anon = `visitor${i}`.padEnd(22, "q");
      const once = applyEvolve(config, request("/", { cookies: { evolve_id: anon } }), event, {
        store: b,
      });
      const twice = applyEvolve(config, request("/", { cookies: { evolve_id: anon } }), event, {
        store: b,
      });
      expect(once!.cookies.get("evolve_a")?.value).toBe(twice!.cookies.get("evolve_a")?.value);
      seen.add(once!.cookies.get("evolve_a")!.value);
    }
    expect(seen.size).toBe(2); // both arms still get visitors
  });

  it("is sticky for a returning visitor and sets no cookies", () => {
    const res = run(
      request("/", { cookies: { evolve_id: "a".repeat(22), evolve_a: "k3j9x2:a8f2l1" } }),
      storeWith(),
      fixed(0.99),
    );
    expect(rewritten(res)).toBe("/ev_k3j9x2-a8f2l1");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the query string and nested paths", () => {
    expect(rewritten(run(request("/pricing?plan=pro")))).toBe(
      "/ev_k3j9x2-c1d2e3.p7q8r9~s4t5u6/pricing?plan=pro",
    );
    expect(rewritten(run(request("/pricing/")))).toMatch(/^\/ev_.+\/pricing$/);
  });

  it("bots get control and no cookies", () => {
    for (const ua of [GOOGLEBOT, null, ""]) {
      const res = run(request("/", { ua }));
      expect(rewritten(res)).toBe("/ev_0");
      expect(res!.headers.get("set-cookie")).toBeNull();
    }
  });

  it("no bundle → control, no cookies", () => {
    const empty = createMemoryStore({ site: TEST_SITE, keys, pollMs: 60_000 });
    const res = run(request("/"), empty);
    expect(rewritten(res)).toBe("/ev_0");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("no secret key configured → control, no cookies", () => {
    const res = applyEvolve(config, request("/"), event, { env: {} });
    expect(rewritten(res)).toBe("/ev_0");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("expired bundle → control, no cookies", () => {
    const now = vi.spyOn(Date, "now");
    const store = storeWith();
    now.mockReturnValue(Date.now() + 15 * 86_400_000);
    const res = run(request("/"), store);
    expect(rewritten(res)).toBe("/ev_0");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("consent denied → control, no cookies", () => {
    const withConsent = defineConfig({ routes: { "/": { mode: "static" } }, consent: () => false });
    const res = applyEvolve(withConsent, request("/"), event, {
      store: storeWith(),
      random: fixed(0.75),
    });
    expect(rewritten(res)).toBe("/ev_0");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("route with only a completed experiment renders the winner without cookies", () => {
    const store = storeWith((b) => {
      b.routing.routes["/pricing"] = ["p7q8r9"];
    });
    const res = run(request("/pricing"), store);
    expect(rewritten(res)).toBe("/ev_p7q8r9~s4t5u6/pricing");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("direct /ev_* access is a 404", () => {
    for (const p of ["/ev_0", "/ev_0/pricing", "/ev_k3j9x2-c1d2e3", "/ev_anything/x"]) {
      expect(run(request(p))!.status, p).toBe(404);
    }
  });

  it("non-Evolve routes are left alone", () => {
    expect(run(request("/signup"))).toBeNull();
    expect(run(request("/pricing/extra"))).toBeNull();
  });

  it("an internal error serves control", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      peek: () => {
        throw new Error("boom");
      },
      load: () => false,
      refresh: async () => {},
      current: () => null,
      token: () => null,
    };
    expect(rewritten(run(request("/"), broken))).toBe("/ev_0");
  });

  it("Cache-Control: private, no-store off Vercel only", () => {
    expect(run(request("/"))!.headers.get("cache-control")).toBe("private, no-store");
    expect(run(request("/", { ua: GOOGLEBOT }))!.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    const onVercel = applyEvolve(config, request("/"), event, {
      store: storeWith(),
      env: { VERCEL: "1" },
    });
    expect(onVercel!.headers.get("cache-control")).toBeNull();
    expect(run(request("/signup"))).toBeNull();
  });

  it("adds Server-Timing", () => {
    expect(run(request("/"))!.headers.get("server-timing")).toMatch(/^evolve;dur=\d+\.\d{3}$/);
  });

  it("secure cookie follows the request protocol", () => {
    const res = applyEvolve(
      config,
      request("/", { headers: { "x-forwarded-proto": "http" } }),
      event,
      {
        store: storeWith(),
        random: fixed(0.75),
      },
    );
    expect(res!.cookies.get("evolve_id")?.secure).toBe(false);
  });
});

describe("preview tokens", () => {
  const env = {
    NODE_ENV: "development",
    EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
    EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
  };
  const token = (payload: object) => signJws(payload, { ...TEST_KEY, typ: PREVIEW_TYP });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const runPv = (req: ReturnType<typeof request>) =>
    applyEvolve(config, req, event, { store: storeWith(), env, random: fixed(0.1) });

  it("a valid token forces the code, sets a session evolve_pv cookie and no assignment cookies", () => {
    const t = token({ site: TEST_SITE, code: "ev_k3j9x2-c1d2e3", exp });
    const res = runPv(request(`/?evolve_preview=${t}`));
    expect(rewritten(res)).toBe(`/ev_k3j9x2-c1d2e3?evolve_preview=${t}`);
    const pv = res!.cookies.get("evolve_pv");
    expect(pv?.value).toBe(t);
    expect(pv?.maxAge).toBeUndefined();
    expect(res!.cookies.get("evolve_a")).toBeUndefined();
    expect(res!.cookies.get("evolve_id")).toBeUndefined();
  });

  it("the evolve_pv cookie keeps the preview on later pages", () => {
    const t = token({ site: TEST_SITE, code: "ev_k3j9x2-c1d2e3.p7q8r9-m1n2o3", exp });
    const res = runPv(request("/pricing", { cookies: { evolve_pv: t } }));
    expect(rewritten(res)).toBe("/ev_k3j9x2-c1d2e3.p7q8r9-m1n2o3/pricing");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("expired, other-site or forged tokens are ignored (normal assignment)", () => {
    const bad = [
      token({ site: TEST_SITE, code: "ev_k3j9x2-c1d2e3", exp: exp - 7200 }),
      token({ site: "site_zzzzzzzzzz", code: "ev_k3j9x2-c1d2e3", exp }),
      signJws(
        { site: TEST_SITE, code: "ev_k3j9x2-c1d2e3", exp },
        { ...generateTestKeyPair(TEST_KEY.kid), typ: PREVIEW_TYP },
      ),
      "not-a-token",
    ];
    for (const t of bad) {
      const res = runPv(request(`/?evolve_preview=${t}`));
      expect(rewritten(res)).toMatch(/^\/ev_k3j9x2-a8f2l1/);
      expect(res!.cookies.get("evolve_pv")).toBeUndefined();
    }
  });
});

describe("proxy (dynamic mode)", () => {
  it("passes the code and path as request headers", () => {
    const res = run(
      request("/features"),
      storeWith((b) => (b.routing.routes["/features"] = ["k3j9x2"])),
    );
    expect(isRewrite(res!)).toBe(false);
    expect(res!.headers.get("x-middleware-request-x-evolve-a")).toBe("ev_k3j9x2-c1d2e3");
    expect(res!.headers.get("x-middleware-request-x-evolve-path")).toBe("/features");
  });
});

describe("prefetch and RSC requests", () => {
  it("take the same path as documents (rewrite + sticky)", () => {
    const cookies = { evolve_id: "a".repeat(22), evolve_a: "k3j9x2:c1d2e3" };
    const variants: Record<string, string>[] = [
      { rsc: "1" },
      { rsc: "1", "next-router-prefetch": "1" },
      { "next-router-state-tree": "%5B%22%22%5D", rsc: "1" },
    ];
    for (const headers of variants) {
      const res = run(request("/pricing?_rsc=abc", { cookies, headers }), storeWith(), fixed(0.1));
      expect(rewritten(res)).toBe("/ev_k3j9x2-c1d2e3.p7q8r9~s4t5u6/pricing?_rsc=abc");
    }
  });
});

describe("matcher (the init-written config)", () => {
  const proxyConfig = { matcher: ["/", "/pricing", "/features", "/(ev_.*)"] };
  const matches = (url: string) => doesProxyMatch({ config: proxyConfig, url });
  it("covers every Evolve route and /ev_* paths", () => {
    for (const u of ["/", "/pricing", "/features", "/ev_0", "/ev_0/pricing", "/ev_k3j9x2-c1d2e3"]) {
      expect(matches(u), u).toBe(true);
    }
  });
  it("leaves other paths alone", () => {
    for (const u of ["/signup", "/api/evolve/collect", "/_next/static/chunk.js", "/pricing/x"]) {
      expect(matches(u), u).toBe(false);
    }
  });
});

describe("createEvolveProxy", () => {
  it("returns next() for other routes", () => {
    const proxy = createEvolveProxy(config, { store: storeWith() });
    const res = proxy(request("/signup"), event as never) as NextResponse;
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects invalid config at startup", () => {
    expect(() => createEvolveProxy({ routes: { pricing: { mode: "static" } } })).toThrow(
      /must start with/,
    );
    expect(() => createEvolveProxy({ routes: { "/ev_x": { mode: "static" } } })).toThrow(/ev_/);
  });

  it("in-proxy p95 < 1 ms (exact and constrained routes, TPL-1.1)", () => {
    const person = "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)";
    const withPatterns = defineConfig({
      routes: { ...config.routes, [person]: { mode: "static" }, "/lp/:slug": { mode: "static" } },
    });
    const store = storeWith((b) => {
      b.routing.routes[person] = ["k3j9x2"];
    });
    const proxy = createEvolveProxy(withPatterns, { store });
    const reqs = Array.from({ length: 50 }, (_, i) =>
      i % 4 === 1
        ? request("/")
        : i % 4 === 2
          ? request("/Christopher-G")
          : i % 4 === 3
            ? request(`/${"A".repeat(2000)}`)
            : request("/pricing", {
                cookies: { evolve_id: "a".repeat(22), evolve_a: "k3j9x2:a8f2l1" },
              }),
    );
    for (const r of reqs) proxy(r, event as never);
    const times: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const r = reqs[i % reqs.length]!;
      const t0 = performance.now();
      proxy(r, event as never);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(1 * SLACK);
  });
});

describe("cdnRouting (repeat views skip the proxy)", () => {
  const cdn = defineConfig({
    routes: {
      "/": { mode: "static" },
      "/pricing": { mode: "static" },
      "/features": { mode: "dynamic" },
    },
    cdnRouting: true,
  });
  const runCdn = (req: ReturnType<typeof request>, store = storeWith()) =>
    applyEvolve(cdn, req, event, { store, random: fixed(0.75) });
  const routeCookie = cdnCookieName("/");

  it("sets the route cookie to the served code, expiring after the poll interval", () => {
    const res = runCdn(request("/"));
    expect(rewritten(res)).toBe("/ev_k3j9x2-c1d2e3");
    expect(res!.cookies.get(routeCookie)).toMatchObject({
      value: "ev_k3j9x2-c1d2e3",
      maxAge: resolveConfig(cdn).pollSeconds,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    // The assignment cookies are unchanged.
    expect(res!.cookies.get("evolve_a")?.value).toBe("k3j9x2:c1d2e3");
  });

  it("re-issues it for a returning visitor whose route cookie expired", () => {
    const res = runCdn(
      request("/", { cookies: { evolve_id: "Gspa9Q9OSdh6cZqKJa1VtA", evolve_a: "k3j9x2:a8f2l1" } }),
    );
    expect(rewritten(res)).toBe("/ev_k3j9x2-a8f2l1");
    expect(res!.cookies.get(routeCookie)?.value).toBe("ev_k3j9x2-a8f2l1");
    expect(res!.cookies.get("evolve_a")).toBeUndefined();
  });

  it("sets none when nothing runs there, for bots, without consent, or on dynamic routes", () => {
    const none = storeWith((b) => {
      b.routing.routes["/"] = [];
    });
    expect(runCdn(request("/"), none)!.headers.get("set-cookie")).toBeNull();
    expect(runCdn(request("/", { ua: GOOGLEBOT }))!.headers.get("set-cookie")).toBeNull();
    const noConsent = defineConfig({
      routes: { "/": { mode: "static" } },
      cdnRouting: true,
      consent: () => false,
    });
    const r = applyEvolve(noConsent, request("/"), event, {
      store: storeWith(),
      random: fixed(0.75),
    });
    expect(r!.headers.get("set-cookie")).toBeNull();
    expect(runCdn(request("/features"))!.cookies.get(cdnCookieName("/features"))).toBeUndefined();
  });

  it("is off by default", () => {
    expect(run(request("/"))!.cookies.get(routeCookie)).toBeUndefined();
  });
});

// T19.5 drill: an idle instance kept serving an old bundle for minutes.
describe("stale bundle: a cookie naming what the bundle doesn't know", () => {
  const storeFetching = () => {
    const onDemandFetches = vi.fn();
    const store = createMemoryStore({
      site: TEST_SITE,
      keys,
      pollMs: 60_000,
      initialToken: signBundle(sampleBundle()),
      fetcher: async (_etag, o) => {
        if (o?.cloud) onDemandFetches();
        return { status: "not_modified" };
      },
    });
    return { store, onDemandFetches };
  };

  it.each([
    ["an experiment it doesn't know", "zzzzzz:yyyyyy"],
    ["a variant it doesn't know", "k3j9x2:yyyyyy"],
  ])("%s → one background refresh from the cloud, handed to waitUntil", async (_, cookie) => {
    const { store, onDemandFetches } = storeFetching();
    const waitUntil = vi.fn();
    applyEvolve(
      config,
      request("/", { cookies: { evolve_id: "AAAAAAAAAAAAAAAAAAAAAA", evolve_a: cookie } }),
      { waitUntil },
      { store },
    );
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
    expect(onDemandFetches).toHaveBeenCalledTimes(1);
  });

  it("known pairs and the excluded marker don't; repeats share the on-demand window", async () => {
    const { store, onDemandFetches } = storeFetching();
    const waitUntil = vi.fn();
    const visit = (a: string) =>
      applyEvolve(
        config,
        request("/", { cookies: { evolve_id: "AAAAAAAAAAAAAAAAAAAAAA", evolve_a: a } }),
        { waitUntil },
        { store },
      );
    visit("k3j9x2:c1d2e3");
    visit("k3j9x2:x");
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
    expect(onDemandFetches).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) visit("zzzzzz:yyyyyy"); // forged
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
    expect(onDemandFetches).toHaveBeenCalledTimes(1);
  });
});
