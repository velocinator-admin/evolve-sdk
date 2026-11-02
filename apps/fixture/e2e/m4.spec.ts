import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { APP_URL, CLOUD_URL, DB_URL } from "./env";

// M4: the (fake) cloud sends a signed aggregate request; the fixture computes
// sufficient statistics in its own Postgres and answers, signed.
// Ids are unique to this file so other specs' browsing never shows up here.
const EXP = "m4agg1";
const A = "m4va01";
const B = "m4vb01";

test.describe.configure({ mode: "serial" });
// Its own pool: e2e/db.ts's shared one is closed by other specs in the same worker.
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const goal = (key: string, def: Record<string, unknown>) => ({
  key,
  role: key === "signed_up" ? "primary" : "secondary",
  hash: `h-${key}`,
  def: { window: "7d", unit: "visitor", direction: "increase", ...def },
});
const experiments = [
  {
    id: EXP,
    variants: [A, B],
    cohortsFrom: "2026-11-20",
    goals: [
      goal("signed_up", {
        kind: "event",
        event: "signup_submit",
        source: null,
        where: null,
        value: null,
      }),
      goal("paid", {
        kind: "event",
        event: "subscription_started",
        source: "stripe",
        where: null,
        value: { kind: "local-fn" },
        window: "30d",
      }),
      goal("signup_page", { kind: "pageview", path: "/signup", value: null, window: "1d" }),
    ],
  },
];

test.beforeAll(async () => {
  await sql`delete from evolve.exposures where experiment_id = ${EXP}`;
  await sql`delete from evolve.events where anon_id like 'm4-%' or user_id like 'm4-%'`;
  await sql`delete from evolve.identities where anon_id like 'm4-%'`;
  await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path) values
    (${EXP}, 'm4-1', ${A}, '2026-11-20T10:00:00Z', '/'),
    (${EXP}, 'm4-2', ${A}, '2026-11-20T11:00:00Z', '/'),
    (${EXP}, 'm4-3', ${B}, '2026-11-20T12:00:00Z', '/'),
    (${EXP}, 'm4-4', ${B}, '2026-11-21T09:00:00Z', '/')`;
  await sql`insert into evolve.identities (anon_id, user_id) values ('m4-3', 'm4-user3')`;
  await sql`insert into evolve.events (ts, name, anon_id, user_id, goal_values, source, path) values
    ('2026-11-20T10:05:00Z', '$pageview', 'm4-1', null, null, 'browser', '/signup'),
    ('2026-11-20T10:06:00Z', 'signup_submit', 'm4-1', null, null, 'browser', '/signup'),
    ('2026-11-20T13:00:00Z', 'signup_submit', 'm4-3', null, null, 'browser', '/signup'),
    ('2026-11-22T13:00:00Z', 'subscription_started', null, 'm4-user3', '{"paid": 49}', 'stripe', null),
    ('2026-11-22T13:00:00Z', 'subscription_started', 'm4-4', null, '{"paid": 19}', 'browser', null)`;
});

type Exchange = {
  status: number;
  verified: boolean;
  response: { rows: Record<string, unknown>[]; partial: boolean; errors: unknown[] } | null;
};
const aggregate = async (request: import("@playwright/test").APIRequestContext) => {
  const res = await request.post(`${CLOUD_URL}/__control/aggregate`, {
    data: { appUrl: APP_URL, request: { experiments, asOf: "2026-12-01T10:00:00.000Z" } },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Exchange;
};

const stats = (n: number, c: number, s1 = 0, mature = true) => ({
  n,
  c,
  s1,
  s2: s1 * s1,
  mn: mature ? n : 0,
  mc: mature ? c : 0,
  ms1: mature ? s1 : 0,
  ms2: mature ? s1 * s1 : 0,
});

test("the fixture answers with exact, signed sufficient statistics", async ({ request }) => {
  const x = await aggregate(request);
  expect(x.status).toBe(200);
  expect(x.verified).toBe(true);
  expect(x.response?.partial).toBe(false);
  expect(x.response?.errors).toEqual([]);
  const row = (goalKey: string, v: string, day: string, s: ReturnType<typeof stats>) => ({
    exp: EXP,
    var: v,
    goal: goalKey,
    seg: "main",
    day,
    ...s,
  });
  expect(x.response?.rows).toEqual([
    row("signed_up", A, "2026-11-20", stats(2, 1)),
    row("signed_up", B, "2026-11-20", stats(1, 1)),
    row("signed_up", B, "2026-11-21", stats(1, 0)),
    // m4-3 pays through the server (user id only); m4-4's payment isn't from stripe.
    // The 30-day window hasn't ended by asOf, so nothing is mature yet.
    row("paid", A, "2026-11-20", stats(2, 0, 0, false)),
    row("paid", B, "2026-11-20", stats(1, 1, 49, false)),
    row("paid", B, "2026-11-21", stats(1, 0, 0, false)),
    row("signup_page", A, "2026-11-20", stats(2, 1)),
    row("signup_page", B, "2026-11-20", stats(1, 0)),
    row("signup_page", B, "2026-11-21", stats(1, 0)),
  ]);
});

test("a forged request is refused", async ({ request }) => {
  const res = await request.post(`${APP_URL}/api/evolve/aggregate`, {
    headers: { "evolve-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
    data: { type: "aggregate.request" },
  });
  expect(res.status()).toBe(401);
});

// Spec §18 scenario 11: stale and replayed requests are refused; the same
// requestId twice gets the identical response and the query runs once.
test("stale or replayed requests are refused; a repeated requestId is answered from the first run", async ({
  request,
}) => {
  const send = async (data: Record<string, unknown>) => {
    const res = await request.post(`${CLOUD_URL}/__control/aggregate`, {
      data: { appUrl: APP_URL, ...data },
    });
    expect(res.ok()).toBe(true);
    return (await res.json()) as Exchange & { request: { requestId: string; asOf: string } };
  };
  const req = { experiments, asOf: "2026-12-01T10:00:00.000Z" };
  const delivery = `m4-replay-${Date.now()}`; // the app remembers delivery ids for 10 min

  const stale = await send({ request: req, t: Math.floor(Date.now() / 1000) - 3600 });
  expect(stale.status).toBe(401);

  const t = Math.floor(Date.now() / 1000);
  const first = await send({ request: req, delivery: delivery, t });
  expect(first.status).toBe(200);
  const replay = await send({ request: req, delivery: delivery, t });
  expect(replay.status).toBe(409);
  // T12.5: the same signed message under a fresh delivery id is a replay too.
  const resent = await send({ request: { ...req, requestId: first.request.requestId }, t });
  expect(resent.status).toBe(409);

  const again = await send({ request: { ...req, requestId: first.request.requestId }, t: t + 1 });
  expect(again.status).toBe(200);
  expect(again.verified).toBe(true);
  expect(again.response).toEqual(first.response);
  const runs = await sql`select 1 from evolve.aggregate_runs
                         where request_id = ${first.request.requestId}`;
  expect(runs).toHaveLength(1);
});
