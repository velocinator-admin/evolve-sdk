import {
  type FakeCloud,
  startFakeCloud,
  TEST_SECRET_KEY,
  TEST_SITE,
  TEST_WEBHOOK_SECRET,
} from "@next-evolve/fake-cloud";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshSchema, TEST_DB_URL, testSql } from "../../test/db";
import { aggregateCommand } from "./aggregate";

const sql = testSql();
let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
});
afterAll(async () => {
  await cloud.close();
  await sql.end();
});
beforeEach(async () => {
  await freshSchema(sql);
  await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path) values
    ('k3j9x2', 'a1', 'a8f2l1', '2026-11-20T10:00:00Z', '/'),
    ('k3j9x2', 'a2', 'c1d2e3', '2026-11-20T11:00:00Z', '/')`;
  await sql`insert into evolve.events (ts, name, anon_id, source) values
    ('2026-11-20T12:00:00Z', 'signed_up', 'a2', 'browser')`;
});

const env = () => ({
  EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
  EVOLVE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  EVOLVE_DATABASE_URL: TEST_DB_URL,
  EVOLVE_CLOUD_URL: cloud.url,
});
const request = {
  asOf: "2026-12-01T10:00:00.000Z",
  experiments: [
    {
      id: "k3j9x2",
      variants: ["a8f2l1", "c1d2e3"],
      cohortsFrom: "2026-11-20",
      goals: [
        {
          key: "signed_up",
          role: "primary" as const,
          hash: "h",
          def: {
            kind: "event" as const,
            event: "signed_up",
            window: "7d",
            unit: "visitor" as const,
            source: null,
            where: null,
            value: null,
            direction: "increase" as const,
          },
        },
      ],
    },
  ],
};

function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return { lines, errs, out: (s: string) => lines.push(s), err: (s: string) => errs.push(s) };
}

describe("next-evolve aggregate", () => {
  it("prints the statistics for the cloud's request", async () => {
    cloud.setAggregateRequest(TEST_SITE, request);
    const c = capture();
    expect(await aggregateCommand([], { env: env(), ...c })).toBe(0);
    const printed = JSON.parse(c.lines.join("\n"));
    expect(printed.rows.map((r: { var: string; c: number }) => [r.var, r.c])).toEqual([
      ["a8f2l1", 0],
      ["c1d2e3", 1],
    ]);
    expect(cloud.uploads).toHaveLength(0);
  });

  it("--upload sends the signed response; the cloud verifies it", async () => {
    cloud.setAggregateRequest(TEST_SITE, request);
    const c = capture();
    expect(await aggregateCommand(["--upload"], { env: env(), ...c })).toBe(0);
    expect(c.lines.at(-1)).toMatch(/^Uploaded 2 rows for 1 experiment/);
    const u = cloud.uploads.at(-1);
    expect(u?.verified).toBe(true);
    expect(u?.response?.rows).toHaveLength(2);
  });

  it("explains missing settings and a wrong webhook secret", async () => {
    const c = capture();
    expect(await aggregateCommand(["--upload"], { env: {}, ...c })).toBe(1);
    expect(c.errs[0]).toMatch(/EVOLVE_SECRET_KEY, EVOLVE_DATABASE_URL, EVOLVE_WEBHOOK_SECRET/);
    cloud.setAggregateRequest(TEST_SITE, request);
    const bad = capture();
    const code = await aggregateCommand(["--upload"], {
      env: { ...env(), EVOLVE_WEBHOOK_SECRET: `whsec_${"x".repeat(32)}` },
      ...bad,
    });
    expect(code).toBe(1);
    expect(bad.errs[0]).toMatch(/upload failed \(400/);
  });
});
