import {
  type AggregateRequest,
  type AggregateResponse,
  aggregateResponseSchema,
  createReplayGuard,
  newRequestId,
  signBody,
  verifyBody,
} from "@next-evolve/protocol";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { freshSchema, TEST_DB_URL, testSql } from "../../test/db";
import { resolveConfig } from "../config/config";
import { createSql } from "../db/client";
import { type AggregateRouteDeps, handleAggregate } from "./aggregate-route";

const SITE = "site_ab12cd34ef";
const SECRET = `whsec_${"s".repeat(32)}`;
const env = {
  EVOLVE_WEBHOOK_SECRET: SECRET,
  EVOLVE_SECRET_KEY: `evk_live_${SITE}_${"k".repeat(32)}`,
};

const sql = testSql();
let attributionQueries = 0;
const counted = createSql(TEST_DB_URL, {
  max: 2,
  debug: (_c, q) => {
    if (q.includes("per_unit")) attributionQueries++;
  },
});
beforeEach(async () => {
  await freshSchema(sql);
  attributionQueries = 0;
  await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path) values
    ('k3j9x2', 'a1', 'a8f2l1', '2026-11-20T10:00:00Z', '/'),
    ('k3j9x2', 'a2', 'c1d2e3', '2026-11-20T11:00:00Z', '/'),
    ('p7q8r9', 'a1', 'm1n2o3', '2026-11-21T10:00:00Z', '/pricing')`;
  await sql`insert into evolve.events (ts, name, anon_id, source) values
    ('2026-11-20T12:00:00Z', 'signed_up', 'a2', 'browser')`;
  await sql`insert into evolve.usage_daily (day, tested_pageviews) values
    ('2026-11-19', 3), ('2026-11-20', 5120), ('2026-11-21', 7)`;
});
afterAll(async () => {
  await sql.end();
  await counted.end();
});

const goal = {
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
};

const request = (over: Partial<AggregateRequest> = {}): AggregateRequest => ({
  type: "aggregate.request",
  pv: 1,
  requestId: newRequestId(),
  site: SITE,
  asOf: "2026-12-01T10:00:00.000Z",
  mode: "incremental",
  experiments: [
    { id: "k3j9x2", variants: ["a8f2l1", "c1d2e3"], cohortsFrom: "2026-11-20", goals: [goal] },
    { id: "p7q8r9", variants: ["m1n2o3", "s4t5u6"], cohortsFrom: "2026-11-20", goals: [goal] },
  ],
  usageFrom: "2026-11-20",
  ...over,
});

let delivery = 0;
function post(
  body: unknown,
  opts: { secret?: string; t?: number; delivery?: string; raw?: string } = {},
): Request {
  const text = opts.raw ?? JSON.stringify(body);
  return new Request("http://app.test/api/evolve/aggregate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "evolve-signature": signBody(opts.secret ?? SECRET, text, opts.t),
      "evolve-delivery": opts.delivery ?? `d-${++delivery}`,
    },
    body: text,
  });
}

const deps = (over: Partial<AggregateRouteDeps> = {}): AggregateRouteDeps => ({
  config: resolveConfig({ routes: { "/": { mode: "static" } } }),
  env,
  sql: () => counted,
  sdkVersion: "9.9.9",
  replay: createReplayGuard(),
  ...over,
});

async function ok(res: Response): Promise<AggregateResponse> {
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(verifyBody(res.headers.get("evolve-signature"), text, SECRET).ok).toBe(true);
  return aggregateResponseSchema.parse(JSON.parse(text)) as AggregateResponse;
}

describe("POST /api/evolve/aggregate", () => {
  it("answers a signed request with signed sufficient statistics and usage", async () => {
    const req = request();
    const body = await ok(await handleAggregate(post(req), deps()));
    expect(body).toMatchObject({
      pv: 1,
      requestId: req.requestId,
      site: SITE,
      asOf: req.asOf,
      sdk: "9.9.9",
      mode: "incremental",
      partial: false,
      remaining: [],
      errors: [],
      usage: [
        { day: "2026-11-20", testedPageviews: 5120 },
        { day: "2026-11-21", testedPageviews: 7 },
      ],
    });
    const stats = { s1: 0, s2: 0, ms1: 0, ms2: 0 };
    expect(body.rows).toEqual([
      {
        exp: "k3j9x2",
        var: "a8f2l1",
        goal: "signed_up",
        seg: "main",
        day: "2026-11-20",
        n: 1,
        c: 0,
        mn: 1,
        mc: 0,
        ...stats,
      },
      {
        exp: "k3j9x2",
        var: "c1d2e3",
        goal: "signed_up",
        seg: "main",
        day: "2026-11-20",
        n: 1,
        c: 1,
        mn: 1,
        mc: 1,
        ...stats,
      },
      {
        exp: "p7q8r9",
        var: "m1n2o3",
        goal: "signed_up",
        seg: "main",
        day: "2026-11-21",
        n: 1,
        c: 0,
        mn: 1,
        mc: 0,
        ...stats,
      },
    ]);
    // No visitor or user ids leave the app.
    expect(JSON.stringify(body)).not.toMatch(/"a1"|"a2"/);
  });

  it("same requestId → the stored response; the queries run once", async () => {
    const req = request();
    const first = await ok(await handleAggregate(post(req), deps()));
    expect(attributionQueries).toBe(2);
    const again = await ok(await handleAggregate(post(req), deps()));
    expect(again).toEqual(first);
    expect(attributionQueries).toBe(2);
    const runs = await sql`select status, mode from evolve.aggregate_runs`;
    expect(runs).toEqual([{ status: "done", mode: "incremental" }]);
  });

  it("429 busy while another aggregate holds the lock", async () => {
    const holder = await sql.reserve();
    try {
      await holder`select pg_advisory_lock(hashtext('evolve.aggregate'))`;
      const res = await handleAggregate(post(request()), deps());
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("30");
      expect(await res.json()).toEqual({ busy: true, retryAfter: 30 });
      await holder`select pg_advisory_unlock(hashtext('evolve.aggregate'))`;
    } finally {
      holder.release();
    }
    await ok(await handleAggregate(post(request()), deps()));
  });

  it("budget spent → partial with the remaining experiments", async () => {
    // Each clock read advances 1 s; the budget covers only the first experiment.
    let t = Date.now();
    const now = () => (t += 1000);
    const res = await handleAggregate(
      post(request(), { t: Math.floor(t / 1000) + 1 }),
      deps({
        now,
        config: resolveConfig({ routes: {}, aggregate: { maxMs: 2000 } }),
      }),
    );
    const body = await ok(res);
    expect(body.partial).toBe(true);
    expect(body.remaining).toEqual(["p7q8r9"]);
    expect(new Set(body.rows.map((r) => r.exp))).toEqual(new Set(["k3j9x2"]));
  });

  it("a query over the statement timeout becomes an error entry", async () => {
    // Another session holds a lock on events, so the attribution query waits past its timeout.
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`lock table evolve.events in access exclusive mode`;
      const res = await handleAggregate(
        post(request()),
        deps({ config: resolveConfig({ routes: {}, aggregate: { statementTimeoutMs: 200 } }) }),
      );
      const body = await ok(res);
      expect(body.partial).toBe(false);
      expect(body.errors).toEqual([
        { exp: "k3j9x2", goal: "signed_up", message: "statement timeout" },
        { exp: "p7q8r9", goal: "signed_up", message: "statement timeout" },
      ]);
      expect(body.rows).toEqual([]);
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });

  it("unsupported pv → 400 unsupported_protocol", async () => {
    const res = await handleAggregate(post({ ...request(), pv: 99 }), deps());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_protocol", supported: [1] });
  });

  it("rejects bad signatures, stale and replayed deliveries, other sites and bad bodies", async () => {
    const d = deps();
    const status = async (r: Request, x = d) => (await handleAggregate(r, x)).status;
    expect(await status(post(request(), { secret: `whsec_${"x".repeat(32)}` }))).toBe(401);
    expect(await status(post(request(), { t: Math.floor(Date.now() / 1000) - 301 }))).toBe(401);
    const once = post(request(), { delivery: "same" });
    expect(await status(once)).toBe(200);
    expect(await status(post(request(), { delivery: "same" }))).toBe(409);
    expect(await status(post(request({ site: "site_zzzzzzzzzz" })))).toBe(403);
    expect(await status(post(null, { raw: "{" }))).toBe(400);
    expect(await status(post({ ...request(), mode: "weird" }))).toBe(400);
    expect(await status(post(request()), deps({ env: {} }))).toBe(503);
    expect(await status(post(request()), deps({ sql: () => null }))).toBe(503);
  });
});
