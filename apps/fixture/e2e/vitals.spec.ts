import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { DB_URL } from "./env";

// T17.3: the beacon measures Core Web Vitals in a real browser and sends them once on
// page hide; collect bins them into evolve.vitals_daily for the page's counted pair.
// Other specs browse "/" in parallel, so this one compares before/after counts.

// Its own pool: e2e/db.ts's shared one is closed by other specs in the same worker.
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
test.afterAll(() => sql.end());

const variantOf = async (page: import("@playwright/test").Page, exp: string) => {
  const raw = (await page.context().cookies()).find((c) => c.name === "evolve_a")?.value ?? "";
  return decodeURIComponent(raw)
    .split(".")
    .find((p) => p.startsWith(`${exp}:`))
    ?.split(":")[1];
};
const samples = async (variant: string) => {
  const rows = await sql<{ metric: string; n: number }[]>`
    select metric, sum(count)::int as n from evolve.vitals_daily
    where experiment_id = 'k3j9x2' and variant_id = ${variant} and day = (now() at time zone 'utc')::date
    group by metric`;
  return Object.fromEntries(rows.map((r) => [r.metric, r.n])) as Record<string, number>;
};

test("a page view stores LCP and CLS for the visitor's arm, and INP after a click", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("hero-title")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
  const variant = await variantOf(page, "k3j9x2");
  expect(variant).toBeTruthy();
  const before = await samples(variant!);

  // A click that doesn't navigate: an interaction for INP (and the end of LCP).
  await page.getByTestId("hero-title").click();
  // Chromium creates the interaction's timing entry at the next paint; a person
  // doesn't leave within that frame, so wait for it like they would.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  await page.goto("about:blank"); // pagehide → vitals + flush

  await expect
    .poll(
      async () => {
        const after = await samples(variant!);
        return ["lcp", "cls", "inp"].filter((m) => (after[m] ?? 0) > (before[m] ?? 0));
      },
      { timeout: 10_000 },
    )
    .toEqual(["lcp", "cls", "inp"]);

  // Counts only: the table has no visitor column.
  const cols = await sql`select column_name from information_schema.columns
    where table_schema = 'evolve' and table_name = 'vitals_daily'`;
  expect(cols.map((c) => c.column_name).sort()).toEqual(
    ["bin", "count", "day", "experiment_id", "metric", "variant_id"].sort(),
  );
});
