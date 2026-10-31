import { describe, expect, it } from "vitest";
import {
  type AggregateRequest,
  type AggregateResponse,
  aggregateRequestSchema,
  aggregateResponseSchema,
  MAX_RESPONSE_ROWS,
} from "./aggregate";
import { parseWindowSeconds, serializedGoalSchema } from "./goals";

const goal = {
  kind: "event",
  event: "signed_up",
  window: "7d",
  unit: "visitor",
  source: null,
  where: null,
  value: null,
  direction: "increase",
} as const;

function sampleRequest(): AggregateRequest {
  return {
    type: "aggregate.request",
    pv: 1,
    requestId: "agr_7f3k000000000000000000aa",
    site: "site_ab12cd34ef",
    asOf: "2026-12-01T10:00:00Z",
    mode: "incremental",
    experiments: [
      {
        id: "k3j9x2",
        variants: ["a8f2l1", "c1d2e3"],
        cohortsFrom: "2026-11-20",
        goals: [{ key: "signed_up", role: "primary", hash: "h1", def: goal }],
      },
    ],
    usageFrom: "2026-11-30",
  };
}

const row = {
  exp: "k3j9x2",
  var: "a8f2l1",
  goal: "signed_up",
  seg: "main",
  day: "2026-11-28",
  n: 412,
  c: 19,
  s1: 0,
  s2: 0,
  mn: 0,
  mc: 0,
  ms1: 0,
  ms2: 0,
};

function sampleResponse(): AggregateResponse {
  return {
    pv: 1,
    requestId: "agr_7f3k000000000000000000aa",
    site: "site_ab12cd34ef",
    asOf: "2026-12-01T10:00:00Z",
    sdk: "0.1.0",
    mode: "incremental",
    durationMs: 812,
    partial: false,
    remaining: [],
    rows: [row],
    usage: [{ day: "2026-11-30", testedPageviews: 5120 }],
    errors: [],
  };
}

describe("goal definitions", () => {
  it("parses windows", () => {
    expect(parseWindowSeconds("30m")).toBe(1800);
    expect(parseWindowSeconds("1h")).toBe(3600);
    expect(parseWindowSeconds("7d")).toBe(604_800);
    expect(parseWindowSeconds("365d")).toBe(31_536_000);
    for (const w of ["0d", "366d", "7w", "d", "07d", "1.5d"])
      expect(parseWindowSeconds(w), w).toBeNull();
  });

  it("accepts event and pageview goals with each value kind", () => {
    expect(serializedGoalSchema.safeParse(goal).success).toBe(true);
    expect(
      serializedGoalSchema.safeParse({ ...goal, value: { kind: "prop", path: "amount" } }).success,
    ).toBe(true);
    expect(serializedGoalSchema.safeParse({ ...goal, value: { kind: "local-fn" } }).success).toBe(
      true,
    );
    const pv = {
      kind: "pageview",
      path: "/signup",
      window: "1d",
      unit: "visitor",
      value: null,
      direction: "increase",
    };
    expect(serializedGoalSchema.safeParse(pv).success).toBe(true);
    expect(serializedGoalSchema.safeParse({ ...pv, path: "/docs/*" }).success).toBe(true);
  });

  it("rejects SQL goals (Phase 5) and malformed definitions", () => {
    expect(
      serializedGoalSchema.safeParse({ kind: "sql", sql: "select 1", window: "60d" }).success,
    ).toBe(false);
    expect(serializedGoalSchema.safeParse({ ...goal, window: "7w" }).success).toBe(false);
    expect(
      serializedGoalSchema.safeParse({ ...goal, value: { kind: "prop", path: "a..b" } }).success,
    ).toBe(false);
    const pv = {
      kind: "pageview",
      path: "signup",
      window: "1d",
      unit: "visitor",
      value: null,
      direction: "increase",
    };
    expect(serializedGoalSchema.safeParse(pv).success).toBe(false);
    expect(serializedGoalSchema.safeParse({ ...pv, path: "/a*/b" }).success).toBe(false);
  });
});

describe("aggregate request", () => {
  it("accepts the spec example", () => {
    expect(aggregateRequestSchema.safeParse(sampleRequest()).success).toBe(true);
  });

  it("allows at most 5 experiments", () => {
    const r = sampleRequest();
    r.experiments = Array.from({ length: 6 }, () => r.experiments[0]!);
    expect(aggregateRequestSchema.safeParse(r).success).toBe(false);
  });

  it("rejects bad ids, dates and modes", () => {
    for (const mutate of [
      (r: AggregateRequest) => (r.requestId = "agr_short"),
      (r: AggregateRequest) => (r.asOf = "yesterday"),
      (r: AggregateRequest) => ((r as { mode: string }).mode = "partial"),
      (r: AggregateRequest) => (r.experiments[0]!.cohortsFrom = "2026-13-01"),
      (r: AggregateRequest) => (r.experiments[0]!.goals = []),
    ]) {
      const r = sampleRequest();
      mutate(r);
      expect(aggregateRequestSchema.safeParse(r).success).toBe(false);
    }
  });
});

describe("aggregate response", () => {
  it("accepts the spec example and tolerates added optional fields (e.g. Phase 2 vitals)", () => {
    expect(aggregateResponseSchema.safeParse(sampleResponse()).success).toBe(true);
    expect(aggregateResponseSchema.safeParse({ ...sampleResponse(), vitals: [] }).success).toBe(
      true,
    );
  });

  it(`allows at most ${MAX_RESPONSE_ROWS} rows`, () => {
    const r = sampleResponse();
    r.rows = Array.from({ length: MAX_RESPONSE_ROWS + 1 }, () => row);
    expect(aggregateResponseSchema.safeParse(r).success).toBe(false);
  });

  it("rejects inconsistent counts", () => {
    for (const bad of [
      { c: 413 },
      { mn: 413 },
      { mn: 5, mc: 6 },
      { n: -1 },
      { n: 1.5 },
      { s2: -1 },
    ]) {
      const r = sampleResponse();
      r.rows = [{ ...row, ...bad }];
      expect(aggregateResponseSchema.safeParse(r).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
