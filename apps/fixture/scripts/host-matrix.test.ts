// T23.2: the host matrix's per-host rows and summary table.
import { describe, expect, it } from "vitest";
import { e2eFromReport, perfFromReport, render, rowStatus, SKIPPED_HOSTS } from "./host-matrix";

const scenario = (addedP95: number, p95: number, extra: object = {}) => ({
  addedP95,
  serverTiming: { p95 },
  samples: 100,
  errors: 0,
  challenged: 0,
  ...extra,
});

describe("e2eFromReport", () => {
  it("counts Playwright's stats; a failure fails, flaky passes", () => {
    expect(e2eFromReport({ stats: { expected: 38, unexpected: 0, flaky: 1, skipped: 0 } })).toEqual(
      { status: "pass", passed: 38, failed: 0, flaky: 1, skipped: 0 },
    );
    expect(e2eFromReport({ stats: { expected: 30, unexpected: 2 } })?.status).toBe("fail");
  });
  it("all skipped (the host challenged the runner) is inconclusive; no report is null", () => {
    expect(e2eFromReport({ stats: { expected: 0, skipped: 5 } })?.status).toBe("inconclusive");
    expect(e2eFromReport(null)).toBeNull();
  });
});

describe("perfFromReport", () => {
  it("takes the worst scenario and checks both budgets", () => {
    const ok = perfFromReport({ scenarios: [scenario(0.4, 0.05), scenario(0.7, 0.1)] });
    expect(ok).toMatchObject({ status: "pass", addedP95: 0.7, inProxyP95: 0.1, budgetMs: 5 });
    expect(perfFromReport({ scenarios: [scenario(5.2, 0.1)] })?.status).toBe("fail");
    expect(perfFromReport({ scenarios: [scenario(0.5, 1.2)] })?.status).toBe("fail");
    expect(perfFromReport({ budgetMs: 40, scenarios: [scenario(15, 0.4)] })?.status).toBe("pass");
  });
  it("challenged samples don't fail it; a fully challenged run is inconclusive", () => {
    const some = perfFromReport({
      budgetMs: 40,
      scenarios: [scenario(15, 0.4, { errors: 3, challenged: 3 })],
    });
    expect(some?.status).toBe("pass");
    const all = perfFromReport({
      budgetMs: 40,
      scenarios: [scenario(Number.NaN, Number.NaN, { samples: 0, errors: 44, challenged: 44 })],
    });
    expect(all).toMatchObject({ status: "inconclusive", addedP95: null, inProxyP95: null });
    const broken = perfFromReport({ scenarios: [scenario(0.5, 0.1, { errors: 2 })] });
    expect(broken?.status).toBe("fail");
  });
});

describe("render", () => {
  it("one row per host, the skipped hosts say why, a failing row fails the run", () => {
    const node = {
      host: "node",
      e2e: e2eFromReport({ stats: { expected: 39 } }),
      perf: perfFromReport({ scenarios: [scenario(0.74, 0.1)] }),
    };
    const docker = {
      host: "docker",
      e2e: e2eFromReport({ stats: { expected: 37, unexpected: 2 } }),
      perf: null,
    };
    const md = render([node, docker, ...SKIPPED_HOSTS]);
    expect(md).toContain("| node | ✅ pass | ✅ pass: 39 passed, 0 failed | 0.10 | 0.74 |");
    expect(md).toContain("| docker | ❌ fail |");
    expect(md).toMatch(/\| netlify \| ⏭️ skipped \|.*needs a Netlify account/);
    expect(rowStatus(docker)).toBe("fail");
    expect(rowStatus(SKIPPED_HOSTS[0]!)).toBe("skipped");
  });
});
