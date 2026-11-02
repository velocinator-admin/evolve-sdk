import { describe, expect, it } from "vitest";
import { aggregateRequestSchema, aggregateResponseSchema } from "./aggregate";
import {
  binFor,
  isVitalsMetric,
  MAX_VITALS_ROWS,
  VITALS_BINS,
  VITALS_METRICS,
  vitalsRowSchema,
} from "./vitals";

describe("VITALS_BINS", () => {
  it("has strictly increasing, positive edges for every metric", () => {
    expect(Object.keys(VITALS_BINS).sort()).toEqual([...VITALS_METRICS].sort());
    for (const m of VITALS_METRICS) {
      const edges = VITALS_BINS[m];
      expect(edges[0], m).toBeGreaterThan(0);
      for (let i = 1; i < edges.length; i++) expect(edges[i], m).toBeGreaterThan(edges[i - 1]!);
    }
  });

  it("is fixed in pv 1 (never edit; only add a metric)", () => {
    expect(VITALS_BINS.lcp).toEqual([
      250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3500, 4000, 4500, 5000,
      6000, 7000, 8000, 10000, 12000, 15000, 20000, 30000,
    ]);
    expect(VITALS_BINS.inp).toEqual([
      16, 32, 48, 64, 80, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 600, 800, 1000, 1500,
      2000,
    ]);
    expect(VITALS_BINS.cls).toEqual([
      5, 10, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000,
    ]);
  });

  it("knows its metrics", () => {
    expect(isVitalsMetric("lcp")).toBe(true);
    expect(isVitalsMetric("fcp")).toBe(false);
    expect(isVitalsMetric(1)).toBe(false);
  });
});

describe("binFor", () => {
  it("counts a value equal to an edge in that edge's bin", () => {
    expect(binFor("lcp", 0)).toBe(0);
    expect(binFor("lcp", 250)).toBe(0);
    expect(binFor("lcp", 250.1)).toBe(1);
    expect(binFor("lcp", 2500)).toBe(9);
    expect(binFor("inp", 16)).toBe(0);
    expect(binFor("inp", 17)).toBe(1);
    expect(binFor("inp", 200)).toBe(9);
  });

  it("puts everything above the last edge in the open last bin", () => {
    expect(binFor("lcp", 30000)).toBe(VITALS_BINS.lcp.length - 1);
    expect(binFor("lcp", 30001)).toBe(VITALS_BINS.lcp.length);
    expect(binFor("lcp", 599_999)).toBe(VITALS_BINS.lcp.length);
    expect(binFor("inp", 2001)).toBe(VITALS_BINS.inp.length);
  });

  it("bins CLS in thousandths (edges are ×1000)", () => {
    expect(binFor("cls", 0)).toBe(0);
    expect(binFor("cls", 0.005)).toBe(0);
    expect(binFor("cls", 0.0051)).toBe(1);
    expect(binFor("cls", 0.1)).toBe(5);
    expect(binFor("cls", 0.25)).toBe(9);
    expect(binFor("cls", 1)).toBe(VITALS_BINS.cls.length - 1);
    expect(binFor("cls", 1.2)).toBe(VITALS_BINS.cls.length);
  });
});

const bins = (m: keyof typeof VITALS_BINS, at = 0) => {
  const b = new Array(VITALS_BINS[m].length + 1).fill(0);
  b[at] = 3;
  return b;
};
const row = { exp: "k3j9x2", var: "a8f2l1", metric: "lcp", day: "2026-11-20", bins: bins("lcp") };

describe("vitals rows", () => {
  it("accept one count per bin, the open last bin included", () => {
    for (const m of VITALS_METRICS)
      expect(vitalsRowSchema.safeParse({ ...row, metric: m, bins: bins(m, 2) }).success, m).toBe(
        true,
      );
  });

  it("reject a wrong bin count for a known metric, negative or fractional counts, bad ids/days", () => {
    for (const bad of [
      { ...row, bins: bins("lcp").slice(1) },
      { ...row, bins: [...bins("lcp"), 0] },
      { ...row, bins: bins("lcp").map((_, i) => (i === 0 ? -1 : 0)) },
      { ...row, bins: bins("lcp").map((_, i) => (i === 0 ? 1.5 : 0)) },
      { ...row, exp: "x" },
      { ...row, day: "2026-11-20T00:00:00Z" },
      { ...row, metric: "LCP" },
    ])
      expect(vitalsRowSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("tolerate a metric a newer SDK adds (readers skip it)", () => {
    expect(vitalsRowSchema.safeParse({ ...row, metric: "fcp", bins: [1, 2, 3] }).success).toBe(
      true,
    );
  });
});

describe("aggregate messages with vitals", () => {
  const req = {
    type: "aggregate.request",
    pv: 1,
    requestId: "agr_7f3k000000000000000000aa",
    site: "site_ab12cd34ef",
    asOf: "2026-12-01T10:00:00Z",
    mode: "incremental",
    experiments: [],
    usageFrom: null,
  };
  const res = {
    pv: 1,
    requestId: "agr_7f3k000000000000000000aa",
    site: "site_ab12cd34ef",
    asOf: "2026-12-01T10:00:00Z",
    sdk: "0.5.0",
    mode: "incremental",
    durationMs: 10,
    partial: false,
    remaining: [],
    rows: [],
    usage: [],
    errors: [],
  };

  it("vitals is optional in requests and responses", () => {
    expect(aggregateRequestSchema.parse(req)).not.toHaveProperty("vitals");
    expect(aggregateResponseSchema.parse(res)).not.toHaveProperty("vitals");
    expect(aggregateRequestSchema.parse({ ...req, vitals: { from: "2026-11-20" } }).vitals).toEqual(
      { from: "2026-11-20" },
    );
    expect(aggregateResponseSchema.parse({ ...res, vitals: [row] }).vitals).toEqual([row]);
  });

  it("validates vitals when present", () => {
    expect(aggregateRequestSchema.safeParse({ ...req, vitals: {} }).success).toBe(false);
    expect(aggregateRequestSchema.safeParse({ ...req, vitals: { from: "nov" } }).success).toBe(
      false,
    );
    expect(
      aggregateResponseSchema.safeParse({ ...res, vitals: [{ ...row, bins: [1] }] }).success,
    ).toBe(false);
  });

  it(`caps a response at ${MAX_VITALS_ROWS} vitals rows`, () => {
    const many = (n: number) => Array.from({ length: n }, () => row);
    expect(
      aggregateResponseSchema.safeParse({ ...res, vitals: many(MAX_VITALS_ROWS) }).success,
    ).toBe(true);
    expect(
      aggregateResponseSchema.safeParse({ ...res, vitals: many(MAX_VITALS_ROWS + 1) }).success,
    ).toBe(false);
  });
});
