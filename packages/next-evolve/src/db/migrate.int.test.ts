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
    expect(r.applied).toEqual(["0001_init"]);
    expect(await tables()).toEqual([
      "aggregate_runs",
      "events",
      "exposures",
      "identities",
      "migrations",
      "usage_daily",
    ]);
  });

  it("is idempotent", async () => {
    await migrate(sql);
    expect(await migrate(sql)).toEqual({ applied: [], skipped: ["0001_init"] });
  });

  it("is safe when several runs race", async () => {
    const others = Array.from({ length: 4 }, () => testSql());
    const results = await Promise.all(others.map((s) => migrate(s)));
    await Promise.all(others.map((s) => s.end()));
    expect(results.flatMap((r) => r.applied)).toEqual(["0001_init"]);
  });

  it("rolls back everything when a migration fails", async () => {
    const list = [
      ...(await loadMigrations()),
      { id: "0002_broken", sql: "select nope from nowhere" },
    ];
    await expect(migrate(sql, list)).rejects.toThrow();
    expect(await tables()).toEqual([]);
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
