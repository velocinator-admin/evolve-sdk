import { TEST_SITE } from "@next-evolve/fake-cloud";
import { getRewrittenUrl, isRewrite } from "next/experimental/testing/server";
import type { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLEBOT, keys, request, storeWith } from "../../test/proxy-helpers";
import { defineConfig } from "../config/config";
import { createMemoryStore } from "../store/memory";
import { applyEvolve, createEvolveProxy } from "./proxy";

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
      token: () => null,
    };
    expect(rewritten(run(request("/"), broken))).toBe("/ev_0");
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

describe("createEvolveProxy", () => {
  it("returns next() for other routes", () => {
    const proxy = createEvolveProxy(config, { store: storeWith() });
    const res = proxy(request("/signup"), event as never);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects invalid config at startup", () => {
    expect(() => createEvolveProxy({ routes: { pricing: { mode: "static" } } })).toThrow(
      /must start with/,
    );
    expect(() => createEvolveProxy({ routes: { "/ev_x": { mode: "static" } } })).toThrow(/ev_/);
  });

  it("in-proxy p95 < 1 ms", () => {
    const proxy = createEvolveProxy(config, { store: storeWith() });
    const reqs = Array.from({ length: 50 }, (_, i) =>
      i % 2
        ? request("/")
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
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(1);
  });
});
