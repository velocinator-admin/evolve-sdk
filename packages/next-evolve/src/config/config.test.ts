import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";

const routes = { "/": { mode: "static" as const } };

describe("aggregate.mode and retentionDays", () => {
  it("default to push and no deletion", () => {
    const c = resolveConfig({ routes });
    expect(c.aggregate.mode).toBe("push");
    expect(c.retentionDays).toBeNull();
  });

  it("accept pull and a retention of 30 days or more", () => {
    const c = resolveConfig({ routes, aggregate: { mode: "pull" }, retentionDays: 90 });
    expect(c.aggregate).toMatchObject({ mode: "pull", maxMs: 25_000 });
    expect(c.retentionDays).toBe(90);
  });

  it("reject bad values", () => {
    expect(() => resolveConfig({ routes, retentionDays: 7 })).toThrow(/retentionDays/);
    expect(() => resolveConfig({ routes, retentionDays: 30.5 })).toThrow(/retentionDays/);
    expect(() => resolveConfig({ routes, aggregate: { mode: "poll" as "pull" } })).toThrow(
      /aggregate.mode/,
    );
  });
});
