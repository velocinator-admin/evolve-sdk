import { describe, expect, it, vi } from "vitest";
import { computeGoalValues, defineGoals, matchesPageviewGoal, serializeGoals } from "./goals";

const goals = defineGoals({
  cta_click: { event: "cta_click", window: "1d" },
  signup_page: { pageview: "/signup", window: "1d" },
  docs: { pageview: "/docs/*" },
  activated: { event: "project_created", window: "7d", unit: "user" },
  paid: {
    event: "subscription_started",
    source: "stripe",
    window: "30d",
    value: (e) => Number(e.props.amount),
  },
  big_order: { event: "order", value: "order.total", where: { plan: "pro" } },
});

const e = (over = {}) => ({
  name: "subscription_started",
  props: { amount: 49 },
  value: null,
  source: "stripe",
  userId: "u1",
  anonId: null,
  ...over,
});

describe("defineGoals / serializeGoals", () => {
  it("serializes with defaults; function values become local-fn", () => {
    const s = serializeGoals(goals);
    expect(s.cta_click).toEqual({
      kind: "event",
      event: "cta_click",
      source: null,
      where: null,
      value: null,
      window: "1d",
      unit: "visitor",
      direction: "increase",
    });
    expect(s.paid?.value).toEqual({ kind: "local-fn" });
    expect(s.big_order?.value).toEqual({ kind: "prop", path: "order.total" });
    expect(s.signup_page).toMatchObject({ kind: "pageview", path: "/signup", value: null });
    expect(s.activated?.unit).toBe("user");
    expect(JSON.stringify(s)).not.toContain("Number(");
  });

  it("rejects SQL goals, bad keys, bad windows and bad paths", () => {
    // @ts-expect-error SQL goals are Phase 5
    expect(() => defineGoals({ churned: { sql: "select 1", window: "60d" } })).toThrow(/SQL goals/);
    expect(() => defineGoals({ "Bad-Key": { event: "x" } })).toThrow(/goal key/);
    // @ts-expect-error not a window
    expect(() => defineGoals({ a: { event: "x", window: "1w" } })).toThrow(/window/);
    expect(() => defineGoals({ a: { event: "x", window: "400d" } })).toThrow(/window/);
    expect(() => defineGoals({ a: { pageview: "signup" } })).toThrow(/invalid/);
    // @ts-expect-error needs event or pageview
    expect(() => defineGoals({ a: { window: "1d" } })).toThrow(/event or pageview/);
  });
});

describe("goal helpers", () => {
  it("matches pageview goals exactly or by prefix", () => {
    expect(matchesPageviewGoal(goals, "/signup")).toBe(true);
    expect(matchesPageviewGoal(goals, "/signup/x")).toBe(false);
    expect(matchesPageviewGoal(goals, "/docs/intro")).toBe(true);
    expect(matchesPageviewGoal(goals, "/pricing")).toBe(false);
    expect(matchesPageviewGoal(undefined, "/signup")).toBe(false);
  });

  it("computes function values for matching events only", () => {
    expect(computeGoalValues(goals, e())).toEqual({ paid: 49 });
    expect(computeGoalValues(goals, e({ source: "browser" }))).toBeNull();
    expect(computeGoalValues(goals, e({ name: "other" }))).toBeNull();
    expect(computeGoalValues(goals, e({ props: { amount: "x" } }))).toBeNull();
  });

  it("skips a value function that throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const g = defineGoals({
      boom: {
        event: "x",
        value: () => {
          throw new Error("nope");
        },
      },
    });
    expect(computeGoalValues(g, e({ name: "x" }))).toBeNull();
    vi.restoreAllMocks();
  });
});
