import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { DB_URL } from "./env";

// M16 demo (T20.2/T20.3, D76): /pricing?utm_campaign=spring-sale serves the
// rule's variant server-rendered, keeps it on the next page without the UTM,
// and the exposure lands in segment = rule id. The session ends → back to the
// visitor's assigned arm.
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const ANON = "UtmRuleE2eVisitor00001";

test("a UTM rule serves its variant for the session and counts in its segment", async ({
  browser,
  baseURL,
}) => {
  await sql`delete from evolve.exposures where anon_id = ${ANON}`;
  const ctx = await browser.newContext();
  // Assigned to control on p7q8r9, so the rule's variant is visibly different.
  await ctx.addCookies([
    { name: "evolve_id", value: ANON, url: baseURL! },
    { name: "evolve_a", value: "p7q8r9:m1n2o3", url: baseURL! },
  ]);
  const page = await ctx.newPage();

  // Server-rendered: the HTML already carries the rule's variant.
  const res = await page.goto("/pricing?utm_campaign=spring-sale");
  expect(await res!.text()).toContain("Start free trial");
  await expect(page.getByTestId("pricing-cta")).toHaveText("Start free trial");
  const cookies = await ctx.cookies();
  const r = cookies.find((c) => c.name === "evolve_r");
  expect(decodeURIComponent(r!.value)).toBe("p7q8r9:r1s2t3");
  expect(r?.expires).toBe(-1); // session cookie
  // The rule doesn't touch the assignment.
  const a = decodeURIComponent(cookies.find((c) => c.name === "evolve_a")?.value ?? "");
  expect(a.split(".")).toContain("p7q8r9:m1n2o3");

  // Next page view without the UTM: still the rule's variant.
  await page.goto("/pricing");
  await expect(page.getByTestId("pricing-cta")).toHaveText("Start free trial");
  await page.goto("about:blank"); // pagehide → the beacon flushes

  await expect
    .poll(
      async () =>
        (
          await sql`select variant_id, segment from evolve.exposures
          where anon_id = ${ANON} and experiment_id = 'p7q8r9'`
        )[0] ?? null,
      { timeout: 10_000 },
    )
    .toEqual({ variant_id: "s4t5u6", segment: "r1s2t3" });

  // Session over (the session cookie is gone): back to the assigned arm.
  await ctx.clearCookies({ name: "evolve_r" });
  const back = await ctx.newPage();
  await back.goto("/pricing");
  await expect(back.getByTestId("pricing-cta")).toHaveText("Get started");
  await ctx.close();
});
