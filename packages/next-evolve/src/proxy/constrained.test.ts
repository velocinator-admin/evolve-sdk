// TPL-1.1: regex-constrained route params. `/:name(…)` serves person pages
// like /Christopher-G without catching /pricing or other top-level pages.
import { getRewrittenUrl, isRewrite } from "next/experimental/testing/server";
import type { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { request, storeWith } from "../../test/proxy-helpers";
import { defineConfig } from "../config/config";
import { applyEvolve, createEvolveProxy } from "./proxy";

const SLACK = process.env.CI ? 3 : 1;
const PERSON = "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)";
const event = { waitUntil: vi.fn() };

const rewritten = (res: NextResponse | null) => {
  expect(res && isRewrite(res)).toBe(true);
  return new URL(getRewrittenUrl(res!)!).pathname;
};

const cfg = defineConfig({
  routes: {
    "/pricing": { mode: "static" },
    [PERSON]: { mode: "static" },
    "/:any": { mode: "static" },
  },
});
const store = storeWith((b) => {
  b.routing.routes = { [PERSON]: ["k3j9x2"], "/pricing": ["p7q8r9"] };
});
const go = (path: string) => applyEvolve(cfg, request(path), event, { store, random: () => 0.9 });

describe("constrained route params (TPL-1.1)", () => {
  it("serves the experiment on a page the constraint matches", () => {
    expect(rewritten(go("/Christopher-G"))).toBe("/ev_k3j9x2-c1d2e3/Christopher-G");
    expect(rewritten(go("/Mary-Ann-Smith"))).toBe("/ev_k3j9x2-c1d2e3/Mary-Ann-Smith");
  });

  it("doesn't catch /pricing or other pages the constraint rejects", () => {
    expect(rewritten(go("/pricing"))).toBe("/ev_p7q8r9~s4t5u6/pricing");
    // /about falls to the unconstrained /:any, which has no bundle route: control.
    expect(rewritten(go("/about"))).toBe("/ev_0/about");
    expect(rewritten(go("/christopher-g"))).toBe("/ev_0/christopher-g");
  });

  it("an invalid constraint is refused at startup", () => {
    expect(() => defineConfig({ routes: { "/:x((?:a+)+)": { mode: "static" } } })).toThrow(
      /nested quantifiers/,
    );
    expect(() => defineConfig({ routes: { "/:x((?=a)a)": { mode: "static" } } })).toThrow(
      /lookarounds/,
    );
  });

  it("in-proxy p95 < 1 ms with constrained routes", () => {
    const proxy = createEvolveProxy(cfg, { store });
    const long = `/${"A".repeat(3000)}`; // non-matching: no '-'
    const paths = ["/Christopher-G", "/pricing", "/about", "/Christopher-Titus", long];
    const reqs = Array.from({ length: 50 }, (_, i) => request(paths[i % paths.length]!));
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

describe("Next's matcher takes a constrained key as written (evolveMatcher)", () => {
  it("runs the proxy for person pages, not /pricing-like pages", async () => {
    const { unstable_doesMiddlewareMatch: doesMatch } = await import(
      "next/experimental/testing/server"
    );
    const { evolveMatcher } = await import("../config/cdn");
    const matcher = evolveMatcher(defineConfig({ routes: { [PERSON]: { mode: "static" } } }));
    expect(matcher).toContain(PERSON);
    const config = { matcher };
    expect(doesMatch({ config, url: "/Christopher-G" })).toBe(true);
    expect(doesMatch({ config, url: "/pricing" })).toBe(false);
    expect(doesMatch({ config, url: "/Christopher-G/x" })).toBe(false);
  });
});
