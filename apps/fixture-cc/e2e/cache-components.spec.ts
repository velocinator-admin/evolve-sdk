// T23.3 (HOST-2): static mode with `cacheComponents: true`. Pages under
// app/[evolve]/ use "use cache" + cacheLife, so each variant code is one cache
// entry: the right variant per code, and a repeat of a code is served from
// the cache (the render timestamp doesn't change).
import { type APIRequestContext, expect, test } from "@playwright/test";
import { APP_URL, BUNDLE, CLOUD_URL, HUMAN_UA } from "./env";

const A = "k3j9x2:a8f2l1";
const B = "k3j9x2:c1d2e3";

async function get(request: APIRequestContext, path: string, assigned?: string) {
  const res = await request.get(path, {
    headers: { "user-agent": HUMAN_UA, cookie: assigned ? `evolve_a=${assigned}` : "" },
    maxRedirects: 0,
  });
  const html = await res.text();
  const pick = (re: RegExp) => re.exec(html)?.[1] ?? null;
  return {
    res,
    html,
    title: pick(/data-testid="hero-title"[^>]*>([^<]*)</),
    cta: pick(/data-testid="pricing-cta"[^>]*>([^<]*)</),
    at: pick(/data-testid="rendered-at"[^>]*>(\d+)</),
    variant: pick(/data-evolve-v="([a-z0-9]+)"/),
  };
}

test.beforeAll(async ({ request }) => {
  expect((await request.post(`${CLOUD_URL}/__control/publish`, { data: BUNDLE })).ok()).toBe(true);
  // Live once a new visitor gets an assignment cookie.
  await expect
    .poll(async () => (await get(request, "/")).res.headers()["set-cookie"] ?? "", {
      timeout: 15_000,
    })
    .toContain("evolve_a=");
});

test("each code renders its own variant", async ({ request }) => {
  const a = await get(request, "/", A);
  const b = await get(request, "/", B);
  expect(a.title).toBe("Ship faster");
  expect(a.variant).toBe("a8f2l1");
  expect(b.title).toBe("Cached per code");
  expect(b.variant).toBe("c1d2e3");
  expect(b.res.headers()["x-middleware-rewrite"]).toBe("/ev_k3j9x2-c1d2e3");
  // Metadata per code: canonical is the route, non-ev_0 codes are noindex.
  expect(b.html).toMatch(/<link rel="canonical" href="\/"/);
  expect(b.html).toContain('content="noindex, follow"');
  const p = await get(request, "/pricing", "p7q8r9:s4t5u6");
  expect(p.cta).toBe("Start free trial");
});

test("a code is cached once: repeats reuse the render, other codes don't share it", async ({
  request,
}) => {
  const b1 = await get(request, "/", B);
  const a1 = await get(request, "/", A);
  const b2 = await get(request, "/", B);
  const a2 = await get(request, "/", A);
  expect(b1.at).toBeTruthy();
  expect(b2.at).toBe(b1.at);
  expect(a2.at).toBe(a1.at);
  expect(a1.at).not.toBe(b1.at);
  expect(b2.title).toBe("Cached per code");
  expect(a2.title).toBe("Ship faster");
  expect(b2.res.headers()["x-nextjs-cache"]).toBe("HIT");
});

test("control is prerendered at build time", async ({ request }) => {
  const bot = await request.get("/", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
  });
  expect(bot.headers()["x-middleware-rewrite"]).toBe("/ev_0");
  expect(bot.headers()["set-cookie"]).toBeUndefined();
  const html = await bot.text();
  expect(html).toContain("Ship faster");
  expect(html).not.toContain("noindex");
  expect(bot.headers()["x-nextjs-prerender"]).toMatch(/^1/);
});

test("a new visitor gets the variant of their cookie; variant paths 404", async ({ request }) => {
  const first = await get(request, "/");
  const assigned = /evolve_a=([^;]+)/.exec(first.res.headers()["set-cookie"] ?? "")?.[1];
  expect(assigned).toBeTruthy();
  const want = decodeURIComponent(assigned!) === B ? "Cached per code" : "Ship faster";
  expect(first.title).toBe(want);
  expect((await request.get("/ev_k3j9x2-c1d2e3")).status()).toBe(404);
});

test("the page hydrates and navigates without errors", async ({ page, context }) => {
  await context.addCookies([{ name: "evolve_a", value: B, url: APP_URL }]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  await expect(page.getByTestId("hero-title")).toHaveText("Cached per code");
  await page.getByTestId("hero-cta").click();
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  expect(errors).toEqual([]);
});
