import {
  type AggregateRequest,
  type AggregateResponse,
  aggregateResponseSchema,
  createReplayGuard,
  newRequestId,
  signBody,
  VITALS_BINS,
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

describe("POST /api/evolve/aggregate: replay (T12.5)", () => {
  it("a captured request replayed under a fresh delivery id is rejected", async () => {
    const d = deps();
    const text = JSON.stringify(request());
    const signature = signBody(SECRET, text);
    const send = (delivery: string) =>
      handleAggregate(
        new Request("http://app.test/api/evolve/aggregate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "evolve-signature": signature,
            "evolve-delivery": delivery,
          },
          body: text,
        }),
        d,
      );
    expect((await send("first")).status).toBe(200);
    expect((await send("second")).status).toBe(409);
  });

  it("future timestamps, tampered bodies, missing signature or delivery are rejected", async () => {
    const d = deps();
    const text = JSON.stringify(request());
    const send = (headers: Record<string, string>, body = text) =>
      handleAggregate(
        new Request("http://app.test/api/evolve/aggregate", { method: "POST", headers, body }),
        d,
      );
    const now = Math.floor(Date.now() / 1000);
    expect((await send({ "evolve-delivery": "a" })).status).toBe(401);
    expect(
      (
        await send({
          "evolve-signature": signBody(SECRET, text, now + 301),
          "evolve-delivery": "b",
        })
      ).status,
    ).toBe(401);
    const tampered = JSON.stringify({ ...request(), mode: "full" });
    expect(
      (await send({ "evolve-signature": signBody(SECRET, text), "evolve-delivery": "c" }, tampered))
        .status,
    ).toBe(401);
    expect((await send({ "evolve-signature": signBody(SECRET, text) })).status).toBe(409);
  });
});

describe("POST /api/evolve/aggregate: Core Web Vitals (protocol 1.1.0)", () => {
  const OLD_KEYS = [
    "asOf",
    "durationMs",
    "errors",
    "mode",
    "partial",
    "pv",
    "remaining",
    "requestId",
    "rows",
    "sdk",
    "site",
    "usage",
  ];
  beforeEach(async () => {
    await sql`insert into evolve.vitals_daily (experiment_id, variant_id, metric, day, bin, count) values
      ('k3j9x2', 'a8f2l1', 'lcp', '2026-11-19', 3, 50),
      ('k3j9x2', 'a8f2l1', 'lcp', '2026-11-20', 4, 7),
      ('k3j9x2', 'a8f2l1', 'lcp', '2026-11-20', 24, 1),
      ('k3j9x2', 'a8f2l1', 'cls', '2026-11-20', 0, 9),
      ('k3j9x2', 'c1d2e3', 'lcp', '2026-11-21', 8, 2),
      ('k3j9x2', 'c1d2e3', 'inp', '2026-11-21', 20, 4),
      ('k3j9x2', 'zzzzzz', 'lcp', '2026-11-21', 1, 5),
      ('k3j9x2', 'a8f2l1', 'fcp', '2026-11-21', 1, 5),
      ('k3j9x2', 'a8f2l1', 'lcp', '2026-12-02', 1, 5),
      ('p7q8r9', 'm1n2o3', 'cls', '2026-11-22', 2, 3),
      ('zz9999', 'a8f2l1', 'lcp', '2026-11-21', 1, 5)`;
  });
  /** A clock returning `base + offsets[i]` on its i-th read, then the last offset. */
  const clock = (base: number, offsets: number[]) => {
    let i = 0;
    return () => base + offsets[Math.min(i++, offsets.length - 1)]!;
  };
  const bins = (m: keyof typeof VITALS_BINS, at: Record<number, number>) =>
    Array.from({ length: VITALS_BINS[m].length + 1 }, (_, i) => at[i] ?? 0);

  it("not asked → no vitals key: the response is the same shape as 0.4.1's", async () => {
    const body = await ok(await handleAggregate(post(request()), deps()));
    expect(Object.keys(body).sort()).toEqual(OLD_KEYS);
  });

  it("asked → one histogram per experiment × variant × metric × day, from `from` to asOf", async () => {
    const body = await ok(
      await handleAggregate(post(request({ vitals: { from: "2026-11-20" } })), deps()),
    );
    expect(body.errors).toEqual([]);
    // Requested experiments and variants only, known metrics only, days from..asOf.
    expect(body.vitals).toEqual([
      {
        exp: "k3j9x2",
        var: "a8f2l1",
        metric: "cls",
        day: "2026-11-20",
        bins: bins("cls", { 0: 9 }),
      },
      {
        exp: "k3j9x2",
        var: "a8f2l1",
        metric: "lcp",
        day: "2026-11-20",
        bins: bins("lcp", { 4: 7, 24: 1 }),
      },
      {
        exp: "k3j9x2",
        var: "c1d2e3",
        metric: "inp",
        day: "2026-11-21",
        bins: bins("inp", { 20: 4 }),
      },
      {
        exp: "k3j9x2",
        var: "c1d2e3",
        metric: "lcp",
        day: "2026-11-21",
        bins: bins("lcp", { 8: 2 }),
      },
      {
        exp: "p7q8r9",
        var: "m1n2o3",
        metric: "cls",
        day: "2026-11-22",
        bins: bins("cls", { 2: 3 }),
      },
    ]);
    // Rows match the table: every count is accounted for.
    const [t] = await sql`select sum(count)::int as n from evolve.vitals_daily
      where experiment_id in ('k3j9x2', 'p7q8r9') and variant_id <> 'zzzzzz' and metric <> 'fcp'
        and day between '2026-11-20' and '2026-12-01'`;
    expect(body.vitals!.flatMap((v) => v.bins).reduce((a, b) => a + b, 0)).toBe(t!.n);
  });

  it("only for the experiments the response returns (not the remaining ones)", async () => {
    // Clock reads: signature, start, experiment 1, experiment 2 (budget gone), vitals.
    const T = Date.now();
    const now = clock(T, [0, 0, 0, 5000, 0]);
    const body = await ok(
      await handleAggregate(
        post(request({ vitals: { from: "2026-11-20" } }), { t: Math.floor(T / 1000) }),
        deps({ now, config: resolveConfig({ routes: {}, aggregate: { maxMs: 4000 } }) }),
      ),
    );
    expect(body.remaining).toEqual(["p7q8r9"]);
    expect(new Set(body.vitals?.map((v) => v.exp))).toEqual(new Set(["k3j9x2"]));
  });

  it("a failing vitals query → errors[{ goal: '$vitals' }] and no vitals; goal rows unaffected", async () => {
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`lock table evolve.vitals_daily in access exclusive mode`;
      const body = await ok(
        await handleAggregate(
          post(request({ vitals: { from: "2026-11-20" } })),
          deps({ config: resolveConfig({ routes: {}, aggregate: { statementTimeoutMs: 200 } }) }),
        ),
      );
      expect(body).not.toHaveProperty("vitals");
      expect(body.errors).toEqual([{ goal: "$vitals", message: "statement timeout" }]);
      expect(body.rows.length).toBeGreaterThan(0);
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });

  it("no budget left for vitals → a $vitals error, not a missing histogram", async () => {
    // Clock reads: signature, start, both experiments in budget, then 300 ms left for vitals.
    const T = Date.now();
    const now = clock(T, [0, 0, 0, 0, 4200]);
    const body = await ok(
      await handleAggregate(
        post(request({ vitals: { from: "2026-11-20" } }), { t: Math.floor(T / 1000) }),
        deps({ now, config: resolveConfig({ routes: {}, aggregate: { maxMs: 4500 } }) }),
      ),
    );
    expect(body.remaining).toEqual([]);
    expect(body).not.toHaveProperty("vitals");
    expect(body.errors).toEqual([{ goal: "$vitals", message: "out of time budget" }]);
  });
});

describe("POST /api/evolve/aggregate: pages count (protocol 1.4.0, TPL-1)", () => {
  beforeEach(async () => {
    await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path) values
      ('k3j9x2', 'b1', 'a8f2l1', '2026-11-22T10:00:00Z', '/Christopher-G'),
      ('k3j9x2', 'b2', 'c1d2e3', '2026-11-22T10:00:00Z', '/Christopher-G'),
      ('k3j9x2', 'b3', 'c1d2e3', '2026-11-22T10:00:00Z', '/Mary-Ann'),
      ('k3j9x2', 'b4', 'c1d2e3', '2026-12-05T10:00:00Z', '/After-AsOf')`;
  });

  it("not asked → no pages key", async () => {
    const body = await ok(await handleAggregate(post(request()), deps()));
    expect(body).not.toHaveProperty("pages");
  });

  it("asked → distinct exposed paths per experiment up to asOf (0 when none)", async () => {
    const body = await ok(
      await handleAggregate(post(request({ pages: ["k3j9x2", "p7q8r9", "zz9999"] })), deps()),
    );
    expect(body.errors).toEqual([]);
    // "/", "/Christopher-G", "/Mary-Ann"; the exposure after asOf doesn't count; zz9999 isn't requested.
    expect(body.pages).toEqual([
      { exp: "k3j9x2", n: 3 },
      { exp: "p7q8r9", n: 1 },
    ]);
    expect(JSON.stringify(body)).not.toContain("Christopher");
  });
});
