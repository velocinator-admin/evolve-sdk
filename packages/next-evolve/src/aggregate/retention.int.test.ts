import { newRequestId } from "@next-evolve/protocol";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { freshSchema, testSql } from "../../test/db";
import { CLEANUP_BATCH, dailyCleanup, retentionStep, WARMUP_HOURS } from "./retention";
import { runAggregate } from "./run";

const sql = testSql();
afterAll(() => sql.end());

const DAY = 86_400_000;
const NOW = Date.parse("2026-12-01T10:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY);
const H = 3_600_000;

beforeEach(async () => {
  await freshSchema(sql);
});

/** Activity tracked since `since` for `ids` (seen just now). */
async function track(ids: string[], since = new Date(NOW - (WARMUP_HOURS + 1) * H)) {
  for (const id of ids) {
    await sql`insert into evolve.experiment_activity (experiment_id, first_seen_at, last_seen_at)
      values (${id}, ${since}, ${new Date(NOW)})`;
  }
}

async function events(...days: number[]) {
  for (const d of days) {
    await sql`insert into evolve.events (ts, received_at, name, anon_id, source)
      values (${ago(d)}, ${ago(d)}, 'signed_up', 'a1', 'browser')`;
  }
}
const eventDays = async () =>
  (
    await sql<{ d: number }[]>`
      select round(extract(epoch from (${new Date(NOW)}::timestamptz - ts)) / 86400)::int as d
      from evolve.events order by ts`
  ).map((r) => r.d);

const run = (over: Partial<Parameters<typeof dailyCleanup>[1]> = {}) =>
  dailyCleanup(sql, { retentionDays: 30, budgetMs: 10_000, now: NOW, ...over });

describe("daily local cleanup (OPS-1)", () => {
  it("deletes events older than retentionDays, once a day", async () => {
    await track(["exp1"]);
    await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path)
      values ('exp1', 'a1', 'v1', ${ago(5)}, '/')`;
    await events(90, 40, 31, 29, 1);
    const r = await run();
    expect(r).toMatchObject({ status: "done", deleted: { events: 3 } });
    expect(await eventDays()).toEqual([29, 1]);
    expect(await run()).toEqual({ status: "skipped", reason: "done_today" });
    const [row] = await sql`select deleted from evolve.cleanup_runs`;
    expect(row?.deleted).toEqual({ events: 3, exposures: 0, vitals: 0 });
  });

  it("keeps everything from the earliest exposure of a running or paused experiment", async () => {
    await track(["old"]);
    // Started 100 days ago: its daily full re-reads from day one.
    await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path)
      values ('old', 'a1', 'v1', ${ago(100)}, '/'), ('old', 'a2', 'v1', ${ago(3)}, '/')`;
    await events(120, 102, 100, 60, 1);
    const r = await run();
    expect(r.status).toBe("done");
    // Cutoff = a day before the first exposure.
    expect(await eventDays()).toEqual([100, 60, 1]);
  });

  it("deletes old exposures only of experiments the cloud stopped asking about", async () => {
    await track(["live"]);
    // `gone` was last asked about 10 days before the latest ask.
    await sql`insert into evolve.experiment_activity (experiment_id, first_seen_at, last_seen_at)
      values ('gone', ${ago(200)}, ${ago(10)})`;
    await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path) values
      ('live', 'a1', 'v1', ${ago(60)}, '/'),
      ('gone', 'a1', 'v1', ${ago(60)}, '/'),
      ('gone', 'a2', 'v1', ${ago(5)}, '/'),
      ('never_seen', 'a3', 'v1', ${ago(45)}, '/')`;
    const r = await run();
    expect(r).toMatchObject({ status: "done", deleted: { exposures: 2 } });
    const left =
      await sql`select experiment_id || ':' || anon_id as k from evolve.exposures order by 1`;
    expect(left.map((x) => x.k)).toEqual(["gone:a2", "live:a1"]);
  });

  it("an outage doesn't make experiments look stopped (active is relative to the latest ask)", async () => {
    // Nothing asked for 20 days; both were seen in the last cycle before the outage.
    await sql`insert into evolve.experiment_activity (experiment_id, first_seen_at, last_seen_at) values
      ('a', ${ago(100)}, ${ago(20)}), ('b', ${ago(100)}, ${ago(20)})`;
    await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path)
      values ('b', 'x', 'v', ${ago(50)}, '/')`;
    await events(55, 49);
    await run();
    expect(await sql`select count(*)::int as n from evolve.exposures`).toEqual([{ n: 1 }]);
    expect(await eventDays()).toEqual([49]);
  });

  it("waits until activity has been tracked for a day before deleting anything", async () => {
    await track(["exp1"], new Date(NOW - 2 * H));
    await events(90);
    expect(await run()).toEqual({ status: "skipped", reason: "warming_up" });
    expect(await eventDays()).toEqual([90]);
  });

  it("deletes in batches, never a row whose time or arrival is recent, and resumes later", async () => {
    await track(["exp1"]);
    const n = CLEANUP_BATCH * 2 + 10;
    await sql`insert into evolve.events (ts, received_at, name, source)
      select ${ago(60)}, ${ago(60)}, 'x', 'server' from generate_series(1, ${n})`;
    // Old arrival, recent time (clock skew) and recent arrival, old time: both stay.
    await sql`insert into evolve.events (ts, received_at, name, source) values
      (${ago(1)}, ${ago(60)}, 'skew', 'server'), (${ago(60)}, ${ago(1)}, 'late', 'server')`;
    expect(await run()).toMatchObject({ status: "done", deleted: { events: n } });
    const left = await sql`select name from evolve.events order by name`;
    expect(left.map((x) => x.name)).toEqual(["late", "skew"]);
  });

  it("stops at the budget, leaves the day open, and the next request finishes it", async () => {
    await track(["exp1"]);
    await events(90);
    expect(await run({ budgetMs: 100 })).toEqual({ status: "skipped", reason: "no_time" });
    expect(await eventDays()).toEqual([90]);
    expect((await run()).status).toBe("done");
    expect(await eventDays()).toEqual([]);
  });

  it("deletes old vitals days", async () => {
    await track(["exp1"]);
    await sql`insert into evolve.vitals_daily (experiment_id, variant_id, metric, day, bin, count) values
      ('exp1', 'v1', 'lcp', ${ago(40).toISOString().slice(0, 10)}, 1, 3),
      ('exp1', 'v1', 'lcp', ${ago(2).toISOString().slice(0, 10)}, 1, 3)`;
    expect(await run()).toMatchObject({ deleted: { vitals: 1 } });
  });

  it("is skipped, not failed, on a database without migration 0003", async () => {
    await sql`drop table evolve.experiment_activity`;
    expect(
      await retentionStep(sql, {
        experimentIds: ["e"],
        retentionDays: 30,
        budgetMs: 5000,
        now: NOW,
      }),
    ).toEqual({ status: "skipped", reason: "not_migrated" });
  });
});

describe("runAggregate with retentionDays", () => {
  const request = (ids: string[]) => ({
    type: "aggregate.request" as const,
    pv: 1,
    requestId: newRequestId(),
    site: "site_ab12cd34ef",
    asOf: new Date(NOW - 120_000).toISOString(),
    mode: "incremental" as const,
    experiments: ids.map((id) => ({
      id,
      variants: ["v1"],
      cohortsFrom: "2026-11-20",
      goals: [
        {
          key: "g",
          role: "primary" as const,
          hash: "h",
          def: {
            kind: "event" as const,
            event: "signed_up",
            window: "1d",
            unit: "visitor" as const,
            source: null,
            where: null,
            value: null,
            direction: "increase" as const,
          },
        },
      ],
    })),
    usageFrom: null,
  });
  const opts = { maxMs: 25_000, statementTimeoutMs: 20_000, sdkVersion: "t" };

  it("records the experiments it was asked about, and cleans up once tracked long enough", async () => {
    await events(90, 1);
    let at = NOW - 2 * DAY;
    await runAggregate(sql, request(["e1", "e2"]), { ...opts, now: () => at, retentionDays: 30 });
    const seen = await sql`select experiment_id from evolve.experiment_activity order by 1`;
    expect(seen.map((r) => r.experiment_id)).toEqual(["e1", "e2"]);
    expect(await eventDays()).toEqual([90, 1]); // warming up
    at = NOW;
    await runAggregate(sql, request(["e1"]), { ...opts, now: () => at, retentionDays: 30 });
    expect(await eventDays()).toEqual([1]);
  });

  it("without retentionDays touches nothing (default)", async () => {
    await events(400);
    await runAggregate(sql, request(["e1"]), { ...opts, now: () => NOW });
    expect(await sql`select count(*)::int as n from evolve.experiment_activity`).toEqual([
      { n: 0 },
    ]);
    expect(await sql`select count(*)::int as n from evolve.cleanup_runs`).toEqual([{ n: 0 }]);
    expect(await eventDays()).toEqual([400]);
  });
});
