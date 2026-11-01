import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshSchema, TEST_DB_URL, testSql } from "../../test/db";
import { createSql } from "./client";
import { createWriter, type EventRow } from "./writer";

const sql = testSql();
const inserts: string[] = [];
const counted = createSql(TEST_DB_URL, {
  max: 2,
  debug: (_c, q) => {
    if (/^\s*insert/i.test(q)) inserts.push(q.split(/\s+/).slice(0, 3).join(" "));
  },
});
beforeEach(async () => {
  await freshSchema(sql);
  inserts.length = 0;
});
afterAll(async () => {
  await sql.end();
  await counted.end();
});

const ev = (over: Partial<EventRow> = {}): EventRow => ({
  ts: new Date(),
  name: "cta_click",
  anon_id: "a1",
  user_id: null,
  value: null,
  goal_values: null,
  props: null,
  source: "browser",
  path: "/",
  dedupe_key: null,
  ...over,
});
const count = async (t: string) =>
  Number((await sql.unsafe(`select count(*)::int as n from evolve.${t}`))[0]?.n);

describe("writer", () => {
  it("writes each table with one multi-row insert per flush", async () => {
    const w = createWriter({ sql: () => counted, mode: "serverless" });
    w.exposures(
      Array.from({ length: 100 }, (_, i) => ({
        experiment_id: "k3j9x2",
        anon_id: `a${i}`,
        variant_id: "c1d2e3",
        path: "/",
        first_at: new Date("2026-10-31T09:00:00Z"),
      })),
    );
    w.events(Array.from({ length: 100 }, (_, i) => ev({ anon_id: `a${i}`, props: { i } })));
    w.identities([{ anon_id: "a1", user_id: "u1" }]);
    w.usage("2026-10-31", 3);
    w.usage("2026-10-31", 2);
    await w.flush();
    expect(inserts).toHaveLength(4);
    expect(await count("exposures")).toBe(100);
    expect(await count("events")).toBe(100);
    const [u] = await sql`select tested_pageviews::int as n from evolve.usage_daily`;
    expect(u?.n).toBe(5);
    const [e] = await sql`select props from evolve.events where anon_id = 'a7'`;
    expect(e?.props).toEqual({ i: 7 });
    // first_at is the receipt time the row carries, not the flush time (attribution
    // needs it on the same clock as event ts).
    const [x] = await sql`select first_at from evolve.exposures where anon_id = 'a7'`;
    expect((x!.first_at as Date).toISOString()).toBe("2026-10-31T09:00:00.000Z");
  });

  it("keeps the first exposure, the first identity link and one row per dedupe key", async () => {
    const w = createWriter({ sql: () => sql, mode: "serverless" });
    const x = { experiment_id: "e1", anon_id: "a1", path: "/", first_at: new Date() };
    w.exposures([
      { ...x, variant_id: "v1" },
      { ...x, variant_id: "v2" },
    ]);
    w.identities([
      { anon_id: "a1", user_id: "u1" },
      { anon_id: "a1", user_id: "u2" },
    ]);
    w.events([ev({ dedupe_key: "inv_1" }), ev({ dedupe_key: "inv_1" })]);
    await w.flush();
    w.exposures([{ ...x, variant_id: "v3" }]);
    w.identities([{ anon_id: "a1", user_id: "u3" }]);
    w.events([ev({ dedupe_key: "inv_1" })]);
    await w.flush();
    expect((await sql`select variant_id from evolve.exposures`)[0]?.variant_id).toBe("v1");
    expect((await sql`select user_id from evolve.identities`)[0]?.user_id).toBe("u1");
    expect(await count("events")).toBe(1);
  });

  it("adds usage across flushes", async () => {
    const w = createWriter({ sql: () => sql, mode: "serverless" });
    w.usage("2026-10-31", 2);
    await w.flush();
    w.usage("2026-10-31", 3);
    w.usage("2026-11-01", 1);
    await w.flush();
    const rows =
      await sql`select day::text, tested_pageviews::int as n from evolve.usage_daily order by day`;
    expect(rows.map((r) => [r.day, r.n])).toEqual([
      ["2026-10-31", 5],
      ["2026-11-01", 1],
    ]);
  });

  it("node mode flushes at 100 rows without waiting for the timer", async () => {
    const w = createWriter({ sql: () => counted, mode: "node", flushMs: 60_000 });
    w.events(Array.from({ length: 99 }, () => ev()));
    expect(w.pending()).toBe(99);
    w.events([ev()]);
    await vi.waitFor(async () => expect(await count("events")).toBe(100));
    expect(inserts).toHaveLength(1);
  });

  it("node mode flushes on its timer", async () => {
    const w = createWriter({ sql: () => sql, mode: "node", flushMs: 20 });
    w.events([ev()]);
    await vi.waitFor(async () => expect(await count("events")).toBe(1));
  });

  it("node mode buffers while the DB is down and writes once it is back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let db: ReturnType<typeof createSql> = createSql("postgres://evolve:evolve@127.0.0.1:1/x", {
      max: 1,
    });
    const down = db;
    const w = createWriter({ sql: () => db, mode: "node", flushMs: 10, maxBuffer: 50 });
    w.events(Array.from({ length: 80 }, (_, i) => ev({ anon_id: `a${i}` })));
    await w.flush();
    expect(w.pending()).toBe(50); // bounded: the oldest 30 were dropped
    db = sql;
    await vi.waitFor(async () => expect(await count("events")).toBe(50), { timeout: 5000 });
    expect((await sql`select min(anon_id) as a from evolve.events`)[0]?.a).toBe("a30");
    await down.end();
    vi.restoreAllMocks();
  });

  it("serverless mode retries once, then drops and logs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = createSql("postgres://evolve:evolve@127.0.0.1:1/x", { max: 1 });
    const w = createWriter({ sql: () => down, mode: "serverless" });
    w.events([ev()]);
    await w.flush();
    expect(w.pending()).toBe(0);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("batch dropped"), expect.anything());
    await down.end();
    vi.restoreAllMocks();
  });
});
