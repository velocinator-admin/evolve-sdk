// T23.2 host smoke: what must hold on any host, whatever experiments run.
// Bot challenges (Vercel's `x-vercel-mitigated`) skip the test instead of failing it.
import { type APIResponse, expect, test } from "@playwright/test";
import { HUMAN_UA } from "../e2e/env";

const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function skipIfChallenged(res: APIResponse) {
  const mitigated = res.headers()["x-vercel-mitigated"];
  test.skip(Boolean(mitigated), `host challenged the runner (x-vercel-mitigated: ${mitigated})`);
}

const cookies = (res: APIResponse) =>
  res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0]!);

const onVercel = (res: APIResponse) => /vercel/i.test(res.headers().server ?? "");

test("an Evolve route serves a page through the proxy", async ({ request }) => {
  const res = await request.get("/pricing", { headers: { "user-agent": HUMAN_UA } });
  skipIfChallenged(res);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("Pricing");
  // The proxy ran (Server-Timing), unless cdnRouting served a returning visitor.
  expect(res.headers()["server-timing"] ?? "").toMatch(/evolve;dur=/);
  // Off Vercel, a variant must never be cached by URL alone (spec §6.5).
  if (!onVercel(res)) expect(res.headers()["cache-control"]).toBe("private, no-store");
});

test("a visitor keeps their variant", async ({ request }) => {
  const first = await request.get("/", { headers: { "user-agent": HUMAN_UA } });
  skipIfChallenged(first);
  const cookie = cookies(first).join("; ");
  const hero = (html: string) => /data-testid="hero-title"[^>]*>([^<]*)</.exec(html)?.[1];
  const want = hero(await first.text());
  expect(want).toBeTruthy();
  for (let i = 0; i < 3; i++) {
    const again = await request.get("/", { headers: { "user-agent": HUMAN_UA, cookie } });
    skipIfChallenged(again);
    expect(hero(await again.text())).toBe(want);
  }
});

test("variant paths are never served directly", async ({ request }) => {
  const res = await request.get("/ev_0/pricing", { headers: { "user-agent": HUMAN_UA } });
  skipIfChallenged(res);
  expect(res.status()).toBe(404);
});

test("bots get control and no cookies", async ({ request }) => {
  const res = await request.get("/", { headers: { "user-agent": BOT_UA } });
  skipIfChallenged(res);
  expect(res.status()).toBe(200);
  expect(cookies(res).filter((c) => c.startsWith("evolve_"))).toEqual([]);
  expect(await res.text()).toContain('rel="canonical"');
});

test("the page hydrates without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const res = await page.goto("/");
  test.skip(
    Boolean(res?.headers()["x-vercel-mitigated"]),
    "host challenged the runner (x-vercel-mitigated)",
  );
  await expect(page.getByTestId("hero-title")).toBeVisible();
  await page.getByRole("link", { name: "Pricing" }).click();
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  expect(errors).toEqual([]);
});
