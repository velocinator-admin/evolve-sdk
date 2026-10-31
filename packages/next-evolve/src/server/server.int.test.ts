import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshSchema, TEST_DB_URL, testSql } from "../../test/db";
import { defineConfig } from "../config/config";
import { defineGoals } from "../config/goals";
import { closeAllSql } from "../db/client";
import { evolve } from "./evolve";
import { createEvolveHandler } from "./handler";
import { resetRuntime, runtimeWriter } from "./runtime";

const sql = testSql();
const SECRET = "trk_test_secret";
const env = { EVOLVE_DATABASE_URL: TEST_DB_URL, EVOLVE_TRACK_SECRET: SECRET };
const goals = defineGoals({
  paid: {
    event: "subscription_started",
    source: "stripe",
    window: "30d",
    value: (e) => Number(e.props.amount),
  },
});
const { GET, POST } = createEvolveHandler({
  config: defineConfig({ routes: { "/": { mode: "static" } } }),
  goals,
  env,
});

beforeAll(() => freshSchema(sql));
afterAll(async () => {
  await runtimeWriter().flush();
  resetRuntime();
  await closeAllSql();
  await sql.end();
});

const track = (body: unknown, auth = `Bearer ${SECRET}`) =>
  POST(
    new Request("http://app.test/api/evolve/track", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/evolve/track", () => {
  it("rejects a bad bearer", async () => {
    expect((await track({ events: [{ name: "x" }] }, "Bearer nope")).status).toBe(401);
    expect((await track({ events: [{ name: "x" }] }, "")).status).toBe(401);
  });

  it("validates the body (≤ 500 events)", async () => {
    expect((await track({ events: [] })).status).toBe(400);
    const many = Array.from({ length: 501 }, () => ({ name: "x" }));
    expect((await track({ events: many })).status).toBe(400);
  });

  it("writes events with goal values; a repeated dedupeKey is stored once", async () => {
    const e = {
      name: "subscription_started",
      userId: "u_42",
      source: "stripe",
      props: { amount: 49 },
      dedupeKey: "evt_stripe_1",
    };
    const res = await track({ events: [e, e] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });
    await track({ events: [e] });
    const rows =
      await sql`select user_id, source, goal_values from evolve.events where dedupe_key = 'evt_stripe_1'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ user_id: "u_42", source: "stripe", goal_values: { paid: 49 } });
  });
});

describe("evolve.track / evolve.identify", () => {
  it("track writes a server event and never throws", async () => {
    await evolve.track("project_created", { userId: "u_1", props: { plan: "pro" } });
    await evolve.track("", {}); // ignored
    await runtimeWriter().flush();
    const rows =
      await sql`select name, source, user_id, anon_id from evolve.events where name = 'project_created'`;
    expect(rows).toEqual([
      { name: "project_created", source: "server", user_id: "u_1", anon_id: null },
    ]);
  });

  it("identify keeps the first link", async () => {
    await evolve.identify("u_first", { anonId: "anon_a" });
    await evolve.identify("u_second", { anonId: "anon_a" });
    await evolve.identify("u_none"); // no cookie outside a request: ignored
    await runtimeWriter().flush();
    const rows = await sql`select anon_id, user_id from evolve.identities`;
    expect(rows).toEqual([{ anon_id: "anon_a", user_id: "u_first" }]);
  });
});

describe("GET /api/evolve/health", () => {
  it("reports protocol support and whether a DB is configured", async () => {
    const res = await GET(new Request("http://app.test/api/evolve/health"));
    expect(await res.json()).toEqual({ ok: true, protocol: { supported: [1] }, db: true });
    expect((await GET(new Request("http://app.test/api/evolve/other"))).status).toBe(404);
  });
});
