import { describe, expect, it } from "vitest";
import { sampleBundle } from "../test/samples";
import { bundlePayloadSchema, computeBundleHash, parseBundlePayload } from "./bundle";

describe("bundle payload", () => {
  it("accepts a valid bundle", () => {
    expect(parseBundlePayload(sampleBundle()).success).toBe(true);
  });

  it("hash is stable across key order and ignores ver/iat/exp", () => {
    const a = sampleBundle();
    const b = JSON.parse(JSON.stringify(a), (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse())
        : v,
    );
    expect(computeBundleHash(b)).toBe(computeBundleHash(a));
    const resigned = { ...a, ver: 9, iat: 1, exp: 2 };
    expect(computeBundleHash(resigned)).toBe(computeBundleHash(a));
    expect(computeBundleHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash changes when serving content changes", () => {
    const a = sampleBundle();
    const b = sampleBundle();
    b.variants.c1d2e3!.props = { title: "Ship 11x faster" };
    expect(computeBundleHash(b)).not.toBe(computeBundleHash(a));
  });

  it("tolerates unknown fields (forward compatible)", () => {
    const b = sampleBundle() as Record<string, unknown>;
    b.rules = [{ utm: "x" }];
    (b.routing as Record<string, unknown>).future = true;
    const r = parseBundlePayload(b);
    expect(r.success).toBe(true);
    expect(r.success && (r.data as Record<string, unknown>).rules).toEqual([{ utm: "x" }]);
  });

  const invalid: [string, (b: ReturnType<typeof sampleBundle>) => void][] = [
    ["wrong pv type", (b) => ((b as { pv: unknown }).pv = "1")],
    ["bad site", (b) => (b.site = "nope")],
    ["negative ver", (b) => (b.ver = -1)],
    ["exp before iat", (b) => (b.exp = b.iat - 1)],
    ["traffic > 1", (b) => (b.routing.experiments.k3j9x2!.traffic = 1.5)],
    ["negative weight", (b) => (b.routing.experiments.k3j9x2!.variants[0]!.w = -0.1)],
    [
      "all weights zero",
      (b) => {
        for (const v of b.routing.experiments.k3j9x2!.variants) v.w = 0;
      },
    ],
    ["route to unknown experiment", (b) => (b.routing.routes["/"] = ["zzzzzz"])],
    ["route path not absolute", (b) => (b.routing.routes = { pricing: ["k3j9x2"] })],
    ["control not among variants", (b) => (b.routing.experiments.k3j9x2!.control = "zzzzzz")],
    ["variant missing from map", (b) => delete b.variants.c1d2e3],
    ["variant of another experiment", (b) => (b.variants.c1d2e3!.exp = "other1")],
    ["completed without winner", (b) => (b.routing.experiments.k3j9x2!.status = "completed")],
    ["bad experiment id", (b) => (b.routing.experiments = { BAD: b.routing.experiments.k3j9x2! })],
    ["too many experiments per route", (b) => (b.routing.routes["/"] = ["a", "b", "c", "d"])],
  ];
  for (const [name, mutate] of invalid) {
    it(`rejects: ${name}`, () => {
      const b = sampleBundle();
      mutate(b);
      expect(bundlePayloadSchema.safeParse(b).success).toBe(false);
    });
  }

  it("accepts a completed experiment with a winner", () => {
    const b = sampleBundle();
    b.routing.experiments.k3j9x2!.status = "completed";
    b.routing.experiments.k3j9x2!.winner = "c1d2e3";
    expect(parseBundlePayload(b).success).toBe(true);
  });
});
