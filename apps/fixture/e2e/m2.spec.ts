import { expect, test } from "@playwright/test";
import { sql } from "./db";
import { TRACK_SECRET } from "./env";

// M2: beacon → collect → rows in the customer's Postgres; track/identify write locally.

test.afterAll(() => sql.end());

const anonOf = async (page: import("@playwright/test").Page) =>
  (await page.context().cookies()).find((c) => c.name === "evolve_id")?.value ?? "";
const assignment = async (page: import("@playwright/test").Page, exp: string) => {
  const raw = (await page.context().cookies()).find((c) => c.name === "evolve_a")?.value ?? "";
  return decodeURIComponent(raw)
    .split(".")
    .find((p) => p.startsWith(`${exp}:`))
    ?.split(":")[1];
};

test("home → pricing: exposures, goal clicks, page-view goal and identify land in the DB", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("hero-title")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
  const anon = await anonOf(page);
  expect(anon).toMatch(/^[A-Za-z0-9_-]{22}$/);

  await page.getByRole("link", { name: "Pricing" }).click();
  await expect(page.getByTestId("pricing-cta")).toBeVisible();
  // Leave via the goal link: the click is queued and flushed on page hide.
  await page.getByTestId("pricing-cta").click();
  await expect(page).toHaveURL(/\/signup$/);
  // Submit only once React has hydrated, or the form posts natively.
  await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
  await page.getByPlaceholder("you@example.com").fill("ada@example.com");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("signup-done")).toBeVisible();
  await page.goto("about:blank"); // pagehide → flush

  const hero = await assignment(page, "k3j9x2");
  const cta = await assignment(page, "p7q8r9");
  await expect
    .poll(
      async () =>
        (
          await sql`select experiment_id, variant_id from evolve.exposures
                    where anon_id = ${anon} order by experiment_id`
        ).map((r) => `${r.experiment_id}:${r.variant_id}`),
      { timeout: 10_000 },
    )
    .toEqual([`k3j9x2:${hero}`, `p7q8r9:${cta}`]);

  await expect
    .poll(
      async () =>
        (await sql`select name from evolve.events where anon_id = ${anon} order by name`).map(
          (r) => r.name,
        ),
      { timeout: 10_000 },
    )
    .toEqual(["$pageview", "pricing_cta", "signup_submit"]);

  await expect
    .poll(
      async () =>
        (await sql`select user_id from evolve.identities where anon_id = ${anon}`)[0]?.user_id,
      {
        timeout: 10_000,
      },
    )
    .toBe("user:ada@example.com");

  const [usage] = await sql`select tested_pageviews::int as n from evolve.usage_daily`;
  expect(usage?.n).toBeGreaterThanOrEqual(2);
});

test("a bot's beacon stores nothing", async ({ request }) => {
  const res = await request.post("/api/evolve/collect", {
    headers: {
      "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
      origin: "http://localhost:3100",
      cookie: "evolve_id=BBBBBBBBBBBBBBBBBBBBBB",
    },
    data: JSON.stringify({ v: 1, events: [{ t: "ev", n: "bot_click", p: "/" }] }),
  });
  expect(res.status()).toBe(204);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await sql`select 1 from evolve.events where name = 'bot_click'`).toHaveLength(0);
});

test("POST /api/evolve/track: bearer required; Stripe-style events dedupe", async ({ request }) => {
  const bad = await request.post("/api/evolve/track", {
    headers: { authorization: "Bearer wrong" },
    data: { events: [{ name: "x" }] },
  });
  expect(bad.status()).toBe(401);

  const event = {
    name: "subscription_started",
    userId: "user:ada@example.com",
    source: "stripe",
    props: { amount: 49 },
    dedupeKey: "evt_e2e_1",
  };
  for (let i = 0; i < 2; i++) {
    const ok = await request.post("/api/evolve/track", {
      headers: { authorization: `Bearer ${TRACK_SECRET}` },
      data: { events: [event] },
    });
    expect(ok.status()).toBe(200);
  }
  const rows = await sql`select goal_values from evolve.events where dedupe_key = 'evt_e2e_1'`;
  expect(rows).toEqual([{ goal_values: { paid: 49 } }]);
});
