import { TEST_KEY, TEST_PUBLIC_KEY_ENV, TEST_SECRET_KEY, TEST_SITE } from "@next-evolve/fake-cloud";
import { type BundlePayload, PREVIEW_TYP } from "@next-evolve/protocol";
import { signJws } from "@next-evolve/protocol/testing";
import { getRewrittenUrl, isRewrite } from "next/experimental/testing/server";
import type { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GOOGLEBOT, request, storeWith } from "../../test/proxy-helpers";
import { cdnCookieName } from "../config/cdn";
import { defineConfig, type EvolveConfig } from "../config/config";
import { compileRules, firstMatch, requestFacts } from "../core/rules";
import { applyEvolve } from "./proxy";

// Shared CI runners are noisy; budgets are checked strictly on dev machines.
const SLACK = process.env.CI ? 3 : 1;

const config = defineConfig({
  routes: { "/": { mode: "static" }, "/pricing": { mode: "static" } },
});
const event = { waitUntil: vi.fn() };
type Rule = NonNullable<BundlePayload["rules"]>[number];
const spring: Rule = {
  id: "r1s2t3",
  exp: "k3j9x2",
  var: "c1d2e3",
  when: [{ f: "utm_campaign", op: "eq", v: "spring-sale" }],
};
const withRules = (rules: Rule[] = [spring]) => storeWith((b) => (b.rules = rules));
// 0.1 assigns control (a8f2l1); the rule forces c1d2e3.
const run = (req: ReturnType<typeof request>, store = withRules(), cfg: EvolveConfig = config) =>
  applyEvolve(cfg, req, event, { store, random: () => 0.1 });
const rewritten = (res: NextResponse | null) => {
  expect(res && isRewrite(res)).toBe(true);
  return new URL(getRewrittenUrl(res!)!).pathname;
};

describe("UTM rules in the proxy", () => {
  it("a matching visitor gets the rule's variant, counted, and a session evolve_r; evolve_a untouched", () => {
    const res = run(request("/pricing?utm_campaign=spring-sale"));
    expect(rewritten(res)).toBe("/ev_k3j9x2-c1d2e3.p7q8r9~s4t5u6/pricing");
    const r = res!.cookies.get("evolve_r");
    expect(r?.value).toBe("k3j9x2:r1s2t3");
    expect(r?.maxAge).toBeUndefined(); // session cookie
    expect(r).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(res!.cookies.get("evolve_a")).toBeUndefined();
    expect(res!.cookies.get("evolve_id")?.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("persists for the session: the next page without the UTM keeps the rule", () => {
    const first = run(request("/pricing?utm_campaign=spring-sale"));
    const cookies = {
      evolve_id: first!.cookies.get("evolve_id")!.value,
      evolve_r: first!.cookies.get("evolve_r")!.value,
    };
    const second = run(request("/", { cookies }));
    expect(rewritten(second)).toBe("/ev_k3j9x2-c1d2e3");
    expect(second!.headers.get("set-cookie")).toBeNull();
  });

  it("a returning visitor keeps their evolve_a assignment for after the session", () => {
    const cookies = { evolve_id: "a".repeat(22), evolve_a: "k3j9x2:a8f2l1" };
    const ruled = run(request("/?utm_campaign=spring-sale", { cookies }));
    expect(rewritten(ruled)).toBe("/ev_k3j9x2-c1d2e3");
    expect(ruled!.cookies.get("evolve_a")).toBeUndefined();
    // Session over (no evolve_r): back to the assigned arm.
    expect(rewritten(run(request("/", { cookies })))).toBe("/ev_k3j9x2-a8f2l1");
  });

  it("no match: normal assignment, no evolve_r", () => {
    const res = run(request("/?utm_campaign=other"));
    expect(rewritten(res)).toBe("/ev_k3j9x2-a8f2l1");
    expect(res!.cookies.get("evolve_r")).toBeUndefined();
    expect(res!.cookies.get("evolve_a")?.value).toBe("k3j9x2:a8f2l1");
  });

  it("a stale evolve_r (rule removed) is cleared and the visitor assigned normally", () => {
    const res = run(request("/", { cookies: { evolve_r: "k3j9x2:r1s2t3" } }), storeWith());
    expect(rewritten(res)).toBe("/ev_k3j9x2-a8f2l1");
    expect(res!.cookies.get("evolve_r")?.value).toBe("");
  });

  it("bots get control: rules don't apply", () => {
    const res = run(request("/?utm_campaign=spring-sale", { ua: GOOGLEBOT }));
    expect(rewritten(res)).toBe("/ev_0");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("consent denied: control, no evolve_r", () => {
    const cfg = defineConfig({ routes: { "/": { mode: "static" } }, consent: () => false });
    const res = run(request("/?utm_campaign=spring-sale"), withRules(), cfg);
    expect(rewritten(res)).toBe("/ev_0");
    expect(res!.headers.get("set-cookie")).toBeNull();
  });

  it("a preview wins over rules", () => {
    const env = {
      NODE_ENV: "development",
      EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
      EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
    };
    const t = signJws(
      { site: TEST_SITE, code: "ev_k3j9x2~a8f2l1", exp: Math.floor(Date.now() / 1000) + 3600 },
      { ...TEST_KEY, typ: PREVIEW_TYP },
    );
    const res = applyEvolve(
      config,
      request(`/?utm_campaign=spring-sale&evolve_preview=${t}`),
      event,
      { store: withRules(), env },
    );
    expect(rewritten(res)).toBe("/ev_k3j9x2~a8f2l1");
    expect(res!.cookies.get("evolve_r")).toBeUndefined();
  });

  it("an invalid regex rule is skipped; the next rule still matches", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = withRules([
      { ...spring, id: "bad001", var: "a8f2l1", when: [{ f: "utm_campaign", op: "re", v: "(" }] },
      spring,
    ]);
    const res = run(request("/?utm_campaign=spring-sale"), store);
    expect(rewritten(res)).toBe("/ev_k3j9x2-c1d2e3");
    expect(res!.cookies.get("evolve_r")?.value).toBe("k3j9x2:r1s2t3");
  });

  it("country from the configured geo header", () => {
    const cfg = defineConfig({ routes: { "/": { mode: "static" } }, geoHeader: "cf-ipcountry" });
    const store = withRules([{ ...spring, when: [{ f: "country", op: "eq", v: "DE" }] }]);
    const hit = run(request("/", { headers: { "cf-ipcountry": "DE" } }), store, cfg);
    expect(rewritten(hit)).toBe("/ev_k3j9x2-c1d2e3");
    const miss = run(request("/", { headers: { "x-vercel-ip-country": "DE" } }), store, cfg);
    expect(rewritten(miss)).toBe("/ev_k3j9x2-a8f2l1");
  });

  it("with cdnRouting, a rule render sets no CDN cookie (later views keep running the proxy)", () => {
    const cdn = defineConfig({ routes: { "/": { mode: "static" } }, cdnRouting: true });
    const ruled = run(request("/?utm_campaign=spring-sale"), withRules(), cdn);
    expect(ruled!.cookies.get(cdnCookieName("/"))).toBeUndefined();
    const plain = run(request("/"), withRules(), cdn);
    expect(plain!.cookies.get(cdnCookieName("/"))?.value).toBe("ev_k3j9x2-a8f2l1");
  });

  it("rejects an invalid geoHeader", () => {
    expect(() => defineConfig({ routes: {}, geoHeader: "bad header" })).toThrow(/geoHeader/);
  });
});

describe("rule budget (D76)", () => {
  // 20 rules for one experiment, none matching: the worst case evaluates all of them.
  const twenty: Rule[] = Array.from({ length: 20 }, (_, i) => ({
    id: `r${String(i).padStart(5, "0")}`,
    exp: "k3j9x2",
    var: "c1d2e3",
    when: [
      {
        f: "utm_campaign",
        op: i % 4 === 0 ? "re" : i % 4 === 1 ? "in" : i % 4 === 2 ? "prefix" : "eq",
        v: i % 4 === 1 ? [`c${i}`, `d${i}`] : i % 4 === 0 ? `^camp-${i}-(a|b)$` : `camp-${i}`,
      },
      { f: "ref", op: "eq", v: `site${i}.com` },
      { f: "device", op: "eq", v: "mobile" },
    ],
  }));

  it("20 rules evaluate in < 0.2 ms (p95)", () => {
    const store = withRules(twenty);
    const bundle = store.peek()!;
    const rules = compileRules(bundle);
    expect(rules.byId.size).toBe(20);
    const url = new URL("https://acme.test/pricing?utm_campaign=camp-x&utm_source=google");
    const headers = new Headers({
      referer: "https://www.example.com/",
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
    });
    const times: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t0 = performance.now();
      // Fresh facts per request, as in the proxy.
      firstMatch(rules, "k3j9x2", requestFacts(url, headers, "x-vercel-ip-country"));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(0.2 * SLACK);
  });

  it("in-proxy p95 < 1 ms with 20 rules", () => {
    const store = withRules(twenty);
    const reqs = Array.from({ length: 50 }, (_, i) =>
      request(`/pricing?utm_campaign=camp-${i}`, {
        cookies: { evolve_id: "a".repeat(22), evolve_a: "k3j9x2:a8f2l1" },
      }),
    );
    for (const r of reqs) run(r, store);
    const times: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const r = reqs[i % reqs.length]!;
      const t0 = performance.now();
      run(r, store);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(1 * SLACK);
  });
});

describe("pattern routes in the proxy (D77)", () => {
  const cfg = defineConfig({
    routes: {
      "/lp/:slug": { mode: "static" },
      "/docs/:path*": { mode: "dynamic" },
      "/pricing": { mode: "static" },
    },
  });
  const store = storeWith((b) => {
    b.routing.routes = {
      "/lp/:slug": ["k3j9x2"],
      "/lp/special": ["p7q8r9"],
      "/docs/:path*": ["k3j9x2"],
    };
  });
  const go = (path: string, random = 0.9) =>
    applyEvolve(cfg, request(path), event, { store, random: () => random });

  it("serves the pattern's experiment on every matching path, rewriting the real path", () => {
    expect(rewritten(go("/lp/a"))).toBe("/ev_k3j9x2-c1d2e3/lp/a");
    expect(rewritten(go("/lp/b"))).toBe("/ev_k3j9x2-c1d2e3/lp/b");
  });

  it("an exact bundle route wins over the pattern", () => {
    expect(rewritten(go("/lp/special"))).toBe("/ev_p7q8r9~s4t5u6/lp/special");
  });

  it("paths outside the pattern aren't Evolve routes", () => {
    expect(go("/lp/a/b")).toBeNull();
    expect(go("/lp")).toBeNull();
  });

  it("an exact config route with no bundle route serves control", () => {
    expect(rewritten(go("/pricing"))).toBe("/ev_0/pricing");
  });

  it("dynamic mode passes the route pattern as the region path", () => {
    const res = go("/docs/a/b")!;
    expect(res.headers.get("x-middleware-request-x-evolve-a")).toBe("ev_k3j9x2-c1d2e3");
    expect(res.headers.get("x-middleware-request-x-evolve-path")).toBe("/docs/:path*");
  });

  it("rejects malformed patterns in the config", () => {
    expect(() => defineConfig({ routes: { "/lp/:p*/x": { mode: "static" } } })).toThrow(
      /last segment/,
    );
    expect(() => defineConfig({ routes: { "/lp/[slug]": { mode: "static" } } })).toThrow(
      /path or a pattern/,
    );
  });
});
