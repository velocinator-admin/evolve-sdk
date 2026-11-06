import {
  type FakeCloud,
  startFakeCloud,
  TEST_SECRET_KEY,
  TEST_SITE,
  TEST_WEBHOOK_SECRET,
} from "@next-evolve/fake-cloud";
import { createReplayGuard } from "@next-evolve/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshSchema, testSql } from "../../test/db";
import { resolveConfig } from "../config/config";
import { type PullDeps, pullOnce, startAggregatePull } from "./pull";

const sql = testSql();
let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud({ leaseMs: 60_000 });
});
afterAll(async () => {
  await cloud.close();
  await sql.end();
});
beforeEach(async () => {
  await freshSchema(sql);
  await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path) values
    ('k3j9x2', 'a1', 'a8f2l1', now() - interval '3 days', '/'),
    ('k3j9x2', 'a2', 'c1d2e3', now() - interval '3 days', '/')`;
  await sql`insert into evolve.events (ts, name, anon_id, source) values
    (now() - interval '3 days' + interval '1 hour', 'signed_up', 'a2', 'browser')`;
  cloud.pulled.length = 0;
  cloud.uploads.length = 0;
});

const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
const experiment = () => ({
  id: "k3j9x2",
  variants: ["a8f2l1", "c1d2e3"],
  cohortsFrom: day(5),
  goals: [
    {
      key: "signed_up",
      role: "primary" as const,
      hash: "h1",
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
});

const deps = (over: Partial<PullDeps> = {}): PullDeps => ({
  config: resolveConfig({ routes: { "/": { mode: "static" } }, aggregate: { mode: "pull" } }),
  env: { EVOLVE_SECRET_KEY: TEST_SECRET_KEY, EVOLVE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET },
  cloudUrl: cloud.url,
  sql: () => sql,
  sdkVersion: "9.9.9",
  replay: createReplayGuard(),
  ...over,
});

describe("aggregate pull mode (AGG-2)", () => {
  it("polls, runs each request with the push runner, and uploads signed answers", async () => {
    const queued = cloud.queueAggregate({ experiments: [experiment()] });
    const r = await pullOnce(deps());
    expect(r).toEqual({ pulled: 1, uploaded: 1, failed: 0 });
    const [up] = cloud.uploads;
    expect(up).toMatchObject({ site: TEST_SITE, verified: true, pulled: true });
    expect(up?.response?.requestId).toBe(queued.requestId);
    const rows = up!.response!.rows;
    expect(rows.map((x) => [x.var, x.n, x.c])).toEqual([
      ["a8f2l1", 1, 0],
      ["c1d2e3", 1, 1],
    ]);
    // Answered: nothing more to pull.
    expect(await pullOnce(deps())).toEqual({ pulled: 0, uploaded: 0, failed: 0 });
  });

  it("refuses a request not signed with this app's webhook secret", async () => {
    cloud.queueAggregate({ experiments: [experiment()] });
    const logs: string[] = [];
    const r = await pullOnce(
      deps({
        env: {
          EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
          EVOLVE_WEBHOOK_SECRET: `whsec_${"x".repeat(32)}`,
        },
        log: (m) => logs.push(m),
      }),
    );
    expect(r).toEqual({ pulled: 1, uploaded: 0, failed: 1 });
    expect(cloud.uploads).toEqual([]);
    expect(logs.join("\n")).toMatch(/401/);
  });

  it("a request whose lease expired is handed out again and answered once", async () => {
    const c = await startFakeCloud({ leaseMs: 0 });
    try {
      c.queueAggregate({ experiments: [experiment()] });
      // First poll can't reach the DB: not answered, the lease lapses.
      const first = await pullOnce(deps({ cloudUrl: c.url, sql: () => null }));
      expect(first).toEqual({ pulled: 1, uploaded: 0, failed: 1 });
      const second = await pullOnce(deps({ cloudUrl: c.url }));
      expect(second).toEqual({ pulled: 1, uploaded: 1, failed: 0 });
      expect(c.pulled[0]).toMatchObject({ leases: 2, answered: true });
    } finally {
      await c.close();
    }
  });

  it("reports an unreachable cloud without throwing", async () => {
    const r = await pullOnce(deps({ cloudUrl: "http://127.0.0.1:1" }));
    expect(r.error).toMatch(/poll failed/);
  });

  describe("loop", () => {
    let stop: (() => void) | null = null;
    afterEach(() => stop?.());

    it("polls right away and runs one poll at a time", async () => {
      cloud.queueAggregate({ experiments: [experiment()] });
      const polls = () => cloud.calls.filter((x) => x.path === "/v1/aggregate-requests").length;
      const before = polls();
      const loop = startAggregatePull({ ...deps(), intervalMs: 3_600_000 });
      stop = loop.stop;
      expect(await loop.tick()).toBeNull(); // the first poll is still running
      await expect.poll(() => cloud.uploads.length).toBe(1);
      expect(polls() - before).toBe(1);
    });
  });
});
