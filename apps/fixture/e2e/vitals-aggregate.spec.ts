import { VITALS_BINS } from "@next-evolve/protocol";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { APP_URL, CLOUD_URL, DB_URL, HUMAN_UA } from "./env";

// T17.4: real visitors on "/slow" (experiment s1ow01; arm sb0000 delays the LCP image
// by 1.5 s) → vitals_daily → the (fake) cloud's signed aggregate request asks for
// vitals → the response's histograms show the slow arm's LCP p75 above control's.
const EXP = "s1ow01";
const CONTROL = "sa0000";
const SLOW = "sb0000";
const VISITS = 14;

test.describe.configure({ mode: "serial" });
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

type Exchange = {
  status: number;
  verified: boolean;
  response: {
    vitals?: { exp: string; var: string; metric: string; day: string; bins: number[] }[];
    errors: unknown[];
  } | null;
};

/** p75 as the upper edge of the bin holding the 75th percentile (∞ for the open last bin). */
const p75 = (edges: readonly number[], bins: number[]) => {
  const total = bins.reduce((a, b) => a + b, 0);
  let seen = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i]!;
    if (seen >= 0.75 * total) return edges[i] ?? Number.POSITIVE_INFINITY;
  }
  return Number.NaN;
};

test("the slow arm's LCP p75 is above control's in the aggregate response", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const arms = new Set<string>();
  for (let i = 0; i < VISITS || arms.size < 2; i++) {
    const ctx = await browser.newContext({ baseURL: APP_URL, userAgent: HUMAN_UA });
    const page = await ctx.newPage();
    await page.goto("/slow");
    await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
    await expect
      .poll(() =>
        page.getByTestId("slow-image").evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    // Let the image paint (LCP is recorded at render), as a person would see it.
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
    );
    const a = decodeURIComponent(
      (await ctx.cookies()).find((c) => c.name === "evolve_a")?.value ?? "",
    );
    const arm = a.match(new RegExp(`${EXP}:([a-z0-9]{6})`))?.[1];
    if (arm) arms.add(arm);
    await page.goto("about:blank"); // pagehide → vitals
    await ctx.close();
  }
  expect([...arms].sort()).toEqual([CONTROL, SLOW]);

  // Every visit's LCP has landed before the cloud asks.
  await expect
    .poll(
      async () =>
        (
          await sql`select sum(count)::int as n from evolve.vitals_daily
            where experiment_id = ${EXP} and metric = 'lcp'`
        )[0]?.n ?? 0,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(VISITS);

  const today = new Date().toISOString().slice(0, 10);
  const res = await request.post(`${CLOUD_URL}/__control/aggregate`, {
    data: {
      appUrl: APP_URL,
      request: {
        asOf: new Date().toISOString(),
        experiments: [
          {
            id: EXP,
            variants: [CONTROL, SLOW],
            cohortsFrom: today,
            goals: [
              {
                key: "slow_page",
                role: "primary",
                hash: "h-slow",
                def: {
                  kind: "pageview",
                  path: "/slow",
                  window: "1d",
                  unit: "visitor",
                  value: null,
                  direction: "increase",
                },
              },
            ],
          },
        ],
        vitals: { from: today },
      },
    },
  });
  expect(res.ok()).toBe(true);
  const x = (await res.json()) as Exchange;
  expect(x.status).toBe(200);
  expect(x.verified).toBe(true);
  expect(x.response?.errors).toEqual([]);
  const lcp = (v: string) =>
    x.response?.vitals?.find((r) => r.var === v && r.metric === "lcp" && r.day === today)?.bins;
  const control = lcp(CONTROL);
  const slow = lcp(SLOW);
  expect(control, "control LCP histogram").toBeDefined();
  expect(slow, "slow arm LCP histogram").toBeDefined();
  const pc = p75(VITALS_BINS.lcp, control!);
  const ps = p75(VITALS_BINS.lcp, slow!);
  expect(ps).toBeGreaterThan(pc);
  expect(ps).toBeGreaterThanOrEqual(1500);
});
