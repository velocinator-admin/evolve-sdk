import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testSql } from "../../test/db";
import { loadMigrations, migrate } from "./migrate";

const sql = testSql();
beforeEach(async () => {
  await sql`drop schema if exists evolve cascade`;
});
afterAll(() => sql.end());

const tables = async () =>
  (
    await sql<{ t: string }[]>`
      select table_name as t from information_schema.tables
      where table_schema = 'evolve' order by 1`
  ).map((r) => r.t);

describe("migrate", () => {
  it("creates the schema from empty", async () => {
    const r = await migrate(sql);
    expect(r.applied).toEqual(["0001_init", "0002_vitals", "0003_retention"]);
    expect(await tables()).toEqual([
      "aggregate_runs",
      "cleanup_runs",
      "events",
      "experiment_activity",
      "exposures",
      "identities",
      "migrations",
      "usage_daily",
      "vitals_daily",
    ]);
  });

  it("is idempotent", async () => {
    await migrate(sql);
    expect(await migrate(sql)).toEqual({
      applied: [],
      skipped: ["0001_init", "0002_vitals", "0003_retention"],
    });
  });

  it("is safe when several runs race", async () => {
    const others = Array.from({ length: 4 }, () => testSql());
    const results = await Promise.all(others.map((s) => migrate(s)));
    await Promise.all(others.map((s) => s.end()));
    expect(results.flatMap((r) => r.applied)).toEqual([
      "0001_init",
      "0002_vitals",
      "0003_retention",
    ]);
  });

  it("rolls back everything when a migration fails", async () => {
    const list = [
      ...(await loadMigrations()),
      { id: "0099_broken", sql: "select nope from nowhere" },
    ];
    await expect(migrate(sql, list)).rejects.toThrow();
    expect(await tables()).toEqual([]);
  });

  it("upgrades a 0.4.x database (0001 only) to 0002 without touching its rows, idempotently", async () => {
    const [init] = await loadMigrations();
    expect(await migrate(sql, [init!])).toEqual({ applied: ["0001_init"], skipped: [] });
    await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, path, first_at)
      values ('e1', 'a1', 'v1', '/', '2026-11-01T00:00:00Z')`;
    await sql`insert into evolve.usage_daily (day, tested_pageviews) values ('2026-11-01', 7)`;
    const before = await sql`select * from evolve.exposures`;

    expect(await migrate(sql)).toEqual({
      applied: ["0002_vitals", "0003_retention"],
      skipped: ["0001_init"],
    });
    expect(await migrate(sql)).toEqual({
      applied: [],
      skipped: ["0001_init", "0002_vitals", "0003_retention"],
    });
    expect(await sql`select * from evolve.exposures`).toEqual(before);
    expect((await sql`select tested_pageviews::int as n from evolve.usage_daily`)[0]?.n).toBe(7);

    const cols = await sql<{ c: string; t: string; n: string }[]>`
      select column_name as c, data_type as t, is_nullable as n from information_schema.columns
      where table_schema = 'evolve' and table_name = 'vitals_daily' order by ordinal_position`;
    expect(cols.map((c) => `${c.c} ${c.t} ${c.n}`)).toEqual([
      "experiment_id text NO",
      "variant_id text NO",
      "metric text NO",
      "day date NO",
      "bin smallint NO",
      "count bigint NO",
    ]);
    // No visitor column: vitals are counts per experiment × variant × metric × day × bin.
    await sql`insert into evolve.vitals_daily (experiment_id, variant_id, metric, day, bin)
      values ('e1', 'v1', 'lcp', '2026-11-01', 3)`;
    await expect(
      sql`insert into evolve.vitals_daily (experiment_id, variant_id, metric, day, bin)
        values ('e1', 'v1', 'lcp', '2026-11-01', 3)`,
    ).rejects.toThrow(/vitals_daily_pkey/);
  });

  it("enforces the dedupe and first-exposure keys", async () => {
    await migrate(sql);
    await sql`insert into evolve.events (ts, name, source, dedupe_key) values (now(), 'a', 'server', 'k1')`;
    await expect(
      sql`insert into evolve.events (ts, name, source, dedupe_key) values (now(), 'a', 'server', 'k1')`,
    ).rejects.toThrow(/events_dedupe/);
    await sql`insert into evolve.events (ts, name, source) values (now(), 'a', 'server'), (now(), 'a', 'server')`;
    await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, path) values ('e', 'a', 'v', '/')`;
    await expect(
      sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, path) values ('e', 'a', 'w', '/')`,
    ).rejects.toThrow(/exposures_pkey/);
  });
});
