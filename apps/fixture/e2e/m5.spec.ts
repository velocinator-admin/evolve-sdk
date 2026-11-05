import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { simulate } from "../scripts/simulate";
import { APP_URL, CLOUD_URL, DB_URL, TRACK_SECRET } from "./env";

// T9.5: the traffic simulator drives the fixture over HTTP; its visitors land
// in the customer DB and come back through a signed aggregate.
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const HERO = "k3j9x2";
const CONTROL = "a8f2l1";
const B = "c1d2e3";

test("simulated visitors: exposures and conversions land locally and aggregate", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const from = new Date(Date.now() - 1000).toISOString();
  const r = await simulate({
    url: APP_URL,
    visitors: 300,
    path: "/",
    goal: "signup_submit",
    rate: 0.1,
    rates: { [B]: 0.4 },
    serverShare: 0.3,
    trackSecret: TRACK_SECRET,
    seed: 42,
    concurrency: 4,
    keepIds: true,
  });
  expect(r.errors).toBe(0);
  expect(r.visitors).toBe(300);
  const ctrl = r.arms[`${HERO}:${CONTROL}`]!;
  const b = r.arms[`${HERO}:${B}`]!;
  expect(ctrl.n + b.n).toBe(300);
  expect(b.c / b.n).toBeGreaterThan(ctrl.c / ctrl.n);

  // Every simulated visitor's exposure and conversion is in the customer DB.
  const ids = r.ids!;
  const all = [...ids[`${HERO}:${CONTROL}`]!.all, ...ids[`${HERO}:${B}`]!.all];
  const converted = [...ids[`${HERO}:${CONTROL}`]!.converted, ...ids[`${HERO}:${B}`]!.converted];
  await expect
    .poll(
      async () =>
        Number(
          (
            await sql`select count(*)::int as n from evolve.exposures
                      where experiment_id = ${HERO} and anon_id = any(${all})`
          )[0]!.n,
        ),
      { timeout: 15_000 },
    )
    .toBe(300);
  await expect
    .poll(
      async () =>
        Number(
          (
            await sql`select count(distinct anon_id)::int as n from evolve.events
                      where name = 'signup_submit' and anon_id = any(${converted})`
          )[0]!.n,
        ),
      { timeout: 15_000 },
    )
    .toBe(converted.length);

  // The fake cloud's aggregate counts them (plus any other spec's browsing of "/").
  const asOf = new Date(Date.now() + 5000).toISOString();
  const res = await request.post(`${CLOUD_URL}/__control/aggregate`, {
    data: {
      appUrl: APP_URL,
      request: {
        asOf,
        experiments: [
          {
            id: HERO,
            variants: [CONTROL, B],
            cohortsFrom: from.slice(0, 10),
            goals: [
              {
                key: "signed_up",
                role: "primary",
                hash: "h-signed_up",
                def: {
                  kind: "event",
                  event: "signup_submit",
                  window: "7d",
                  unit: "visitor",
                  direction: "increase",
                  source: null,
                  where: null,
                  value: null,
                },
              },
            ],
          },
        ],
      },
    },
  });
  const x = (await res.json()) as {
    verified: boolean;
    response: { rows: { var: string; n: number; c: number }[] };
  };
  expect(x.verified).toBe(true);
  const sum = (v: string, k: "n" | "c") =>
    x.response.rows.filter((row) => row.var === v).reduce((s, row) => s + row[k], 0);
  for (const [v, arm] of [
    [CONTROL, ctrl],
    [B, b],
  ] as const) {
    expect(sum(v, "n")).toBeGreaterThanOrEqual(arm.n);
    expect(sum(v, "c")).toBeGreaterThanOrEqual(arm.c);
  }
});

// T19.5: the simulator can also report Core Web Vitals, as the beacon does at
// pagehide (`exp` pairs + `cwv` in one batch per page view), so a CWV rollback
// can be drilled with a few hundred page views per arm without a browser each.
test("simulated page views report LCP per arm into vitals_daily", async () => {
  test.setTimeout(120_000);
  const EXP = "s1ow01";
  const [CTRL, SLOW] = ["sa0000", "sb0000"];
  await sql`delete from evolve.vitals_daily where experiment_id = ${EXP}`;
  const r = await simulate({
    url: APP_URL,
    visitors: 40,
    path: "/slow",
    goal: "cta_click",
    rate: 0,
    lcp: 1200,
    lcps: { [SLOW]: 2900 },
    views: 3,
    seed: 7,
    concurrency: 4,
  });
  expect(r.errors).toBe(0);
  const views = (v: string) => r.arms[`${EXP}:${v}`]!.n * 3;
  const rows = async () =>
    Object.fromEntries(
      (
        await sql`select variant_id, count(*)::int as n,
            percentile_disc(0.5) within group (order by bin) as mid
          from evolve.vitals_daily, generate_series(1, count)
          where experiment_id = ${EXP} and metric = 'lcp' group by variant_id`
      ).map((x) => [x.variant_id as string, { n: x.n as number, mid: x.mid as number }]),
    );
  await expect.poll(async () => (await rows())[CTRL]?.n, { timeout: 15_000 }).toBe(views(CTRL));
  await expect.poll(async () => (await rows())[SLOW]?.n, { timeout: 15_000 }).toBe(views(SLOW));
  const got = await rows();
  // Medians 1.2 s vs 2.9 s land in clearly different LCP bins.
  expect(got[SLOW]!.mid).toBeGreaterThan(got[CTRL]!.mid);
  // No conversions asked for, none sent.
  expect(Object.values(r.arms).every((a) => a.c === 0)).toBe(true);
});
