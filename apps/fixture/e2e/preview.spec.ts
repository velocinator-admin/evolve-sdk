import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { CLOUD_URL, DB_URL } from "./env";

// Spec §18 scenario 5 (second half): a preview link renders the variant for that
// browser only and records nothing in the customer DB.
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const ANON = "PreviewE2eVisitor00001";

test("a preview link shows the variant, assigns nothing and creates no exposure", async ({
  browser,
  baseURL,
  request,
}) => {
  await sql`delete from evolve.exposures where anon_id = ${ANON}`;
  await sql`delete from evolve.events where anon_id = ${ANON}`;
  const { token } = (await (
    await request.post(`${CLOUD_URL}/__control/preview`, { data: { code: "ev_k3j9x2-c1d2e3" } })
  ).json()) as { token: string };

  const ctx = await browser.newContext();
  // A returning visitor: without the preview check, the beacon would record under this id.
  await ctx.addCookies([{ name: "evolve_id", value: ANON, url: baseURL! }]);
  const page = await ctx.newPage();
  await page.goto(`/?evolve_preview=${encodeURIComponent(token)}`);
  await expect(page.getByTestId("hero-title")).toHaveText("Ship 10x faster");
  await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
  // The preview sticks for the session (client navigation and reloads).
  await page.getByRole("link", { name: "Pricing" }).click();
  await expect(page.getByTestId("pricing-cta")).toBeVisible();
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByTestId("hero-title")).toHaveText("Ship 10x faster");
  await page.goto("about:blank"); // pagehide → the beacon flushes

  const names = (await ctx.cookies()).map((c) => c.name);
  expect(names).not.toContain("evolve_a");
  expect(names).toContain("evolve_pv");
  await ctx.close();

  await new Promise((r) => setTimeout(r, 2_000));
  expect(await sql`select 1 from evolve.exposures where anon_id = ${ANON}`).toHaveLength(0);
  expect(await sql`select 1 from evolve.events where anon_id = ${ANON}`).toHaveLength(0);
});
