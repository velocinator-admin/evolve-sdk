import { type APIRequestContext, expect, test } from "@playwright/test";
import postgres from "postgres";
import {
  CLOUD_URL,
  DB_URL,
  EDGE_APP_URL,
  EDGE_SITE,
  HUMAN_UA,
  M1_BUNDLE,
  OFFLINE_APP_URL,
  OFFLINE_SITE,
} from "./env";

// Spec §18 scenarios 9 and 12 (failure matrix §7.9) on real `next start` apps.
// Each drill has its own app and site (see env.ts), so the other specs never see it.
test.describe.configure({ mode: "serial" });
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const A_TITLE = "Ship faster";
const B_TITLE = "Ship 10x faster";

/** M1's content for another site; `wB` sets the hero's B weight. */
const bundleFor = (site: string, wB = 0.5, times: { iat?: number; exp?: number } = {}) => ({
  ...M1_BUNDLE,
  ...times,
  site,
  routing: {
    ...M1_BUNDLE.routing,
    experiments: {
      ...M1_BUNDLE.routing.experiments,
      k3j9x2: {
        ...M1_BUNDLE.routing.experiments.k3j9x2,
        variants: [
          { id: "a8f2l1", w: 1 - wB },
          { id: "c1d2e3", w: wB },
        ],
      },
    },
  },
});

/** A brand-new visitor's view of `/`. */
const visit = async (appUrl: string, cookie?: string) => {
  const res = await fetch(appUrl, {
    headers: { "user-agent": HUMAN_UA, ...(cookie ? { cookie } : {}) },
  });
  const html = await res.text();
  return {
    status: res.status,
    title: /data-testid="hero-title">([^<]+)</.exec(html)?.[1],
    assigned: (res.headers.get("set-cookie") ?? "").includes("evolve_a="),
    marked: html.includes('data-evolve-e="k3j9x2"'),
  };
};

const outage = (request: APIRequestContext, site: string, down: boolean) =>
  request.post(`${CLOUD_URL}/__control/outage`, { data: { site, down } });
const publish = async (request: APIRequestContext, data: object) =>
  expect((await request.post(`${CLOUD_URL}/__control/publish`, { data })).ok()).toBe(true);

test.describe("scenario 9: the cloud is unreachable", () => {
  test.beforeAll(async ({ request }) => {
    await outage(request, EDGE_SITE, false);
    await publish(request, bundleFor(EDGE_SITE));
    await expect
      .poll(async () => (await visit(EDGE_APP_URL)).assigned, { timeout: 15_000 })
      .toBe(true);
  });

  test("the last bundle keeps serving and events keep landing in the customer DB", async ({
    browser,
    request,
  }) => {
    await outage(request, EDGE_SITE, true);
    try {
      await new Promise((r) => setTimeout(r, 3_000)); // several failed 1 s polls
      const titles = new Set<string | undefined>();
      for (let i = 0; i < 20; i++) {
        const v = await visit(EDGE_APP_URL);
        expect(v.status).toBe(200);
        expect(v.assigned).toBe(true);
        expect(v.marked).toBe(true);
        titles.add(v.title);
      }
      expect([...titles].sort()).toEqual([A_TITLE, B_TITLE].sort());

      const ctx = await browser.newContext({ baseURL: EDGE_APP_URL });
      const page = await ctx.newPage();
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
      const anon = (await ctx.cookies()).find((c) => c.name === "evolve_id")?.value ?? "";
      expect(anon).not.toBe("");
      await page.goto("about:blank");
      await ctx.close();
      await expect
        .poll(
          async () =>
            (await sql`select experiment_id from evolve.exposures where anon_id = ${anon}`).map(
              (r) => r.experiment_id,
            ),
          { timeout: 10_000 },
        )
        .toEqual(["k3j9x2"]);
    } finally {
      await outage(request, EDGE_SITE, false);
    }
  });

  test("an expired bundle → control, no cookies, assignments ignored", async ({ request }) => {
    test.setTimeout(60_000);
    // Everyone gets B, and the bundle expires a few seconds from now.
    const now = Math.floor(Date.now() / 1000);
    await publish(request, bundleFor(EDGE_SITE, 1, { iat: now, exp: now + 8 }));
    // A 50/50 visitor can get B by chance; 10 in a row means the new bundle is live.
    const allB = async () => {
      for (let i = 0; i < 10; i++) if ((await visit(EDGE_APP_URL)).title !== B_TITLE) return false;
      return true;
    };
    await expect.poll(allB, { timeout: 15_000 }).toBe(true);
    await outage(request, EDGE_SITE, true); // no fresh bundle can arrive
    try {
      await expect
        .poll(async () => (await visit(EDGE_APP_URL)).title, { timeout: 20_000, intervals: [500] })
        .toBe(A_TITLE);
      for (let i = 0; i < 5; i++) {
        const v = await visit(EDGE_APP_URL, "evolve_a=k3j9x2:c1d2e3");
        expect(v).toMatchObject({ status: 200, title: A_TITLE, assigned: false, marked: false });
      }
    } finally {
      await outage(request, EDGE_SITE, false);
    }
  });
});

test.describe("scenarios 9 and 12: a fresh app, cloud unreachable from boot, customer DB down", () => {
  test("no bundle at all → control, no cookies", async () => {
    for (let i = 0; i < 5; i++) {
      for (const path of ["/", "/pricing"]) {
        const res = await fetch(new URL(path, OFFLINE_APP_URL), {
          headers: { "user-agent": HUMAN_UA },
        });
        expect(res.status, path).toBe(200);
        expect(res.headers.get("set-cookie"), path).toBeNull();
        expect(await res.text(), path).not.toContain("data-evolve-e");
      }
    }
    expect((await visit(OFFLINE_APP_URL)).title).toBe(A_TITLE);
  });

  test("with the DB down, pages still serve variants, the beacon fails soft and aggregation answers 503", async ({
    browser,
    request,
  }) => {
    await outage(request, OFFLINE_SITE, false);
    await publish(request, bundleFor(OFFLINE_SITE));
    await expect
      .poll(async () => (await visit(OFFLINE_APP_URL)).assigned, { timeout: 15_000 })
      .toBe(true);

    const ctx = await browser.newContext({ baseURL: OFFLINE_APP_URL });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
    await page.getByRole("link", { name: "Pricing" }).click();
    await expect(page.getByTestId("pricing-cta")).toBeVisible();
    const collect = await page.request.post("/api/evolve/collect", {
      headers: { origin: OFFLINE_APP_URL },
      data: JSON.stringify({ v: 1, events: [{ t: "ev", n: "db_down_click", p: "/" }] }),
    });
    expect(collect.status()).toBeLessThan(500);
    expect(errors).toEqual([]);
    await ctx.close();

    const agg = await request.post(`${CLOUD_URL}/__control/aggregate`, {
      data: { appUrl: OFFLINE_APP_URL, site: OFFLINE_SITE, request: { experiments: [] } },
    });
    expect(((await agg.json()) as { status: number }).status).toBe(503);
  });
});
