import { expect, test } from "@playwright/test";
import { HUMAN_UA } from "./env";

const B_TITLE = "Ship 10x faster";
const A_TITLE = "Ship faster";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

test.describe("M1: hello variant from the proxy", () => {
  test("JS disabled: the variant copy is in the server HTML", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    await ctx.addCookies([{ name: "evolve_a", value: "k3j9x2:c1d2e3", url: baseURL! }]);
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("hero-title")).toHaveText(B_TITLE);
    await expect(page.getByTestId("hero-subtitle")).toHaveText("From idea to production in a day");
    const marker = page.locator("[data-evolve-r=hero]");
    await expect(marker).toHaveAttribute("data-evolve-e", "k3j9x2");
    await expect(marker).toHaveAttribute("data-evolve-v", "c1d2e3");
    await ctx.close();
  });

  test("sticky over 20 reloads", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/");
    const first = await page.getByTestId("hero-title").textContent();
    expect([A_TITLE, B_TITLE]).toContain(first);
    const cookie = (await ctx.cookies()).find((c) => c.name === "evolve_a");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    for (let i = 0; i < 20; i++) {
      await page.reload();
      await expect(page.getByTestId("hero-title")).toHaveText(first!);
    }
    // Link prefetches of /pricing may add that test's assignment; the hero one must not change.
    const hero = (v?: string) =>
      /k3j9x2(?::|%3A)([a-z0-9]{6})/.exec(decodeURIComponent(v ?? ""))?.[1];
    const after = (await ctx.cookies()).find((c) => c.name === "evolve_a")?.value;
    expect(hero(after)).toBe(hero(cookie?.value));
    expect(hero(after)).toBeTruthy();
    await ctx.close();
  });

  test("new visitors are split across both variants", async ({ playwright, baseURL }) => {
    const titles = new Map<string, number>();
    for (let i = 0; i < 60; i++) {
      const req = await playwright.request.newContext({ baseURL, userAgent: HUMAN_UA });
      const html = await (await req.get("/")).text();
      const title = /data-testid="hero-title">([^<]+)</.exec(html)?.[1] ?? "?";
      titles.set(title, (titles.get(title) ?? 0) + 1);
      await req.dispose();
    }
    expect([...titles.keys()].sort()).toEqual([A_TITLE, B_TITLE].sort());
    for (const n of titles.values()) expect(n).toBeGreaterThan(10);
  });

  test("Googlebot gets control, no cookies, canonical /", async ({ playwright, baseURL }) => {
    const req = await playwright.request.newContext({ baseURL, userAgent: GOOGLEBOT });
    for (let i = 0; i < 5; i++) {
      const res = await req.get("/");
      expect(res.headers()["set-cookie"]).toBeUndefined();
      const html = await res.text();
      expect(html).toContain(`data-testid="hero-title">${A_TITLE}<`);
      expect(html).not.toContain("data-evolve-e");
      expect(html).toMatch(/<link rel="canonical" href="http:\/\/localhost:3100\/?"/);
      expect(html).not.toContain("noindex");
    }
    await req.dispose();
  });

  test("variant renders are noindex with canonical /", async ({ request }) => {
    const html = await (
      await request.get("/", { headers: { cookie: "evolve_a=k3j9x2:c1d2e3" } })
    ).text();
    expect(html).toContain(B_TITLE);
    expect(html).toMatch(/<meta name="robots" content="noindex, follow"/);
    expect(html).toMatch(/<link rel="canonical" href="http:\/\/localhost:3100\/?"/);
  });

  test("direct /ev_* access is a 404", async ({ request }) => {
    for (const p of ["/ev_0", "/ev_0/pricing", "/ev_k3j9x2-c1d2e3"]) {
      expect((await request.get(p)).status(), p).toBe(404);
    }
  });

  test("second request for a variant code is a cache HIT", async ({ request }) => {
    const headers = { cookie: "evolve_a=p7q8r9:s4t5u6" };
    const first = await request.get("/pricing", { headers });
    expect(await first.text()).toContain("Start free trial");
    const second = await request.get("/pricing", { headers });
    expect(second.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(await second.text()).toContain("Start free trial");
  });

  test("dynamic mode: /features serves variants without moving the page", async ({ request }) => {
    const b = await (
      await request.get("/features", { headers: { cookie: "evolve_a=f5e6a7:fb0000" } })
    ).text();
    expect(b).toContain("All the tools, none of the flicker");
    expect(b).toContain('data-evolve-v="fb0000"');
    const a = await (
      await request.get("/features", { headers: { cookie: "evolve_a=f5e6a7:fa0000" } })
    ).text();
    expect(a).toContain("Everything you need");
    expect(a).toContain('data-evolve-v="fa0000"');
  });

  test("Cache-Control stays private on next start (no shared caching of variants)", async ({
    request,
  }) => {
    for (const p of ["/", "/pricing", "/features"]) {
      const res = await request.get(p, {
        headers: { cookie: "evolve_a=k3j9x2:c1d2e3.p7q8r9:s4t5u6" },
      });
      expect(res.headers()["cache-control"], p).toBe("private, no-store");
    }
    // Twice, so the second /pricing comes from the ISR cache.
    const cached = await request.get("/pricing", { headers: { cookie: "evolve_a=p7q8r9:s4t5u6" } });
    expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(cached.headers()["cache-control"]).toBe("private, no-store");
  });

  test("Server-Timing reports the proxy's cost", async ({ request }) => {
    const st = (await request.get("/")).headers()["server-timing"] ?? "";
    expect(st).toMatch(/evolve;dur=\d+\.\d+/);
  });
});
