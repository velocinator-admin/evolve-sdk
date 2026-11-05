import { type APIRequestContext, type APIResponse, expect, test } from "@playwright/test";
import { CDN_APP_URL, CDN_MAX_AGE, CDN_SITE, CLOUD_URL } from "./env";

// T19.5a: opt-in cdnRouting. After the proxy routes a visitor it sets a route
// cookie; while it lives, next.config's rewrite serves the variant and the
// proxy doesn't run (no Server-Timing, no Set-Cookie). Ids are this spec's own
// because every instance shares one ISR cache directory.
const ROUTE_COOKIE = "evolve_r_bo0mse"; // cdnCookieName("/")
const B = "ev_c4dn01-c4dnb0";
const variants = {
  c4dna0: { exp: "c4dn01", region: "hero", ctrl: true, props: {} },
  c4dnb0: { exp: "c4dn01", region: "hero", ctrl: false, props: { title: "Served by the CDN" } },
};
// As the cloud builds it: a paused experiment isn't routed; its variants still ship.
const bundle = (status: "running" | "paused") => ({
  site: CDN_SITE,
  routing:
    status === "running"
      ? {
          routes: { "/": ["c4dn01"] },
          experiments: {
            c4dn01: {
              status,
              traffic: 1,
              control: "c4dna0",
              variants: [
                { id: "c4dna0", w: 0 },
                { id: "c4dnb0", w: 1 },
              ],
            },
          },
        }
      : { routes: { "/": [] }, experiments: {} },
  variants,
});

const publish = async (request: APIRequestContext, status: "running" | "paused") => {
  const res = await request.post(`${CLOUD_URL}/__control/publish`, {
    data: { ...bundle(status), notify: CDN_APP_URL },
  });
  expect(res.ok()).toBe(true);
};
const get = (request: APIRequestContext, path: string, cookies: Record<string, string> = {}) =>
  request.get(`${CDN_APP_URL}${path}`, {
    headers: {
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
    maxRedirects: 0,
  });
const title = async (res: APIResponse) =>
  /data-testid="hero-title"[^>]*>([^<]*)</.exec(await res.text())?.[1] ?? "";
const ranProxy = (res: APIResponse) => Boolean(res.headers()["server-timing"]?.includes("evolve"));
/** name → { value, maxAge } from the response's Set-Cookie lines. */
const setCookies = (res: APIResponse) =>
  Object.fromEntries(
    res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => {
        const [pair, ...attrs] = h.value.split(";");
        const [name, value] = pair!.split("=");
        const age = attrs.find((a) => /max-age/i.test(a))?.split("=")[1];
        return [name!.trim(), { value: value ?? "", maxAge: age ? Number(age) : undefined }];
      }),
  );
const bundleFetches = async (request: APIRequestContext) =>
  (
    (await (await request.get(`${CLOUD_URL}/__control/state`)).json()) as {
      calls: { path: string; site?: string }[];
    }
  ).calls.filter((c) => c.path === "/v1/bundle" && c.site === CDN_SITE).length;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await publish(request, "running");
  await expect
    .poll(async () => title(await get(request, "/")), { timeout: 15_000 })
    .toBe("Served by the CDN");
});

/** A new visitor's first view: the proxy assigns B and sets the route cookie. */
async function firstView(request: APIRequestContext) {
  const res = await get(request, "/");
  expect(ranProxy(res)).toBe(true);
  const set = setCookies(res);
  expect(set[ROUTE_COOKIE]).toEqual({ value: B, maxAge: CDN_MAX_AGE });
  return {
    evolve_id: set.evolve_id!.value,
    evolve_a: set.evolve_a!.value,
    [ROUTE_COOKIE]: set[ROUTE_COOKIE]!.value,
  };
}

test("a repeat view is served without the proxy, and runs it again once the cookie is gone", async ({
  request,
}) => {
  const cookies = await firstView(request);
  const repeat = await get(request, "/", cookies);
  expect(repeat.status()).toBe(200);
  expect(await title(repeat)).toBe("Served by the CDN");
  expect(ranProxy(repeat)).toBe(false);
  expect(repeat.headers()["set-cookie"]).toBeUndefined();

  // The browser drops the cookie after maxAge: the proxy routes again (same arm, from evolve_a).
  const { [ROUTE_COOKIE]: _gone, ...rest } = cookies;
  const again = await get(request, "/", rest);
  expect(ranProxy(again)).toBe(true);
  expect(await title(again)).toBe("Served by the CDN");
  expect(setCookies(again)[ROUTE_COOKIE]?.value).toBe(B);
});

test("in a browser: reloads within maxAge skip the proxy, after it they don't", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const first = await page.goto(`${CDN_APP_URL}/`);
  expect(first!.headers()["server-timing"]).toContain("evolve");
  await expect(page.getByTestId("hero-title")).toHaveText("Served by the CDN");
  const repeat = await page.reload();
  expect(repeat!.headers()["server-timing"]).toBeUndefined();
  await expect(page.getByTestId("hero-title")).toHaveText("Served by the CDN");
  await page.waitForTimeout(CDN_MAX_AGE * 1000 + 500);
  const expired = await page.reload();
  expect(expired!.headers()["server-timing"]).toContain("evolve");
  await ctx.close();
});

test("previews always run the proxy, even with a route cookie", async ({ request }) => {
  const cookies = await firstView(request);
  const { token } = (await (
    await request.post(`${CLOUD_URL}/__control/preview`, {
      data: { site: CDN_SITE, code: "ev_c4dn01-c4dna0" },
    })
  ).json()) as { token: string };
  const res = await get(request, `/?evolve_preview=${encodeURIComponent(token)}`, cookies);
  expect(ranProxy(res)).toBe(true);
  expect(await title(res)).toBe("Ship faster"); // the previewed control, not the cookie's B
  const pv = setCookies(res).evolve_pv?.value;
  expect(pv).toBeTruthy();
  // The preview session cookie keeps later views on the proxy too.
  const later = await get(request, "/", { ...cookies, evolve_pv: pv! });
  expect(ranProxy(later)).toBe(true);
  expect(await title(later)).toBe("Ship faster");
});

test("a forged route cookie is harmless: control, uncounted, ≤ 1 bundle fetch, malformed → proxy", async ({
  request,
}) => {
  await new Promise((r) => setTimeout(r, 5_500)); // past any earlier fresh-pull window
  const before = await bundleFetches(request);
  const id = "ForgedCdnVisitor000001";
  for (let i = 0; i < 12; i++) {
    const code = `ev_f0rg${String(i).padStart(2, "0")}-f0rgb${i.toString(36)}`;
    const res = await get(request, "/", { evolve_id: id, [ROUTE_COOKIE]: code });
    expect(res.status(), code).toBe(200);
    expect(ranProxy(res)).toBe(false);
    const html = await res.text();
    expect(/data-testid="hero-title"[^>]*>([^<]*)</.exec(html)?.[1]).toBe("Ship faster");
    expect(html).toContain("data-evolve-x"); // rendered, not counted
  }
  expect((await bundleFetches(request)) - before).toBeLessThanOrEqual(1);

  // Not a code at all: the matcher sends it to the proxy, which re-issues the cookie.
  const bad = await get(request, "/", { evolve_id: id, [ROUTE_COOKIE]: "..%2F..%2Fetc" });
  expect(bad.status()).toBe(200);
  expect(ranProxy(bad)).toBe(true);
  expect(setCookies(bad)[ROUTE_COOKIE]?.value).toBe(B);
  // And /ev_* is still never served directly.
  expect((await get(request, `/${B}`)).status()).toBe(404);
});

test("a pause reaches a returning visitor within the cookie's lifetime", async ({
  browser,
  request,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${CDN_APP_URL}/`);
  await expect(page.getByTestId("hero-title")).toHaveText("Served by the CDN");
  await publish(request, "paused");
  const t0 = Date.now();
  // Until the route cookie expires the CDN path keeps serving B (the staleness
  // cdnRouting trades for skipping the proxy); then the proxy, synced by the
  // webhook, serves control.
  const stale = await page.reload();
  expect(stale!.headers()["server-timing"]).toBeUndefined();
  await expect(page.getByTestId("hero-title")).toHaveText("Served by the CDN");
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByTestId("hero-title").textContent();
      },
      { timeout: (CDN_MAX_AGE + 8) * 1000, intervals: [250] },
    )
    .toBe("Ship faster");
  const ms = Date.now() - t0;
  // maxAge, plus the webhook's ≤ 5 s refresh window in case it was slower than the cookie.
  expect(ms).toBeLessThan((CDN_MAX_AGE + 6) * 1000);
  const names = (await ctx.cookies()).map((c) => c.name);
  expect(names).not.toContain(ROUTE_COOKIE); // nothing runs on "/": no new route cookie
  test.info().annotations.push({ type: "latency", description: `pause → control in ${ms} ms` });
  await ctx.close();

  await publish(request, "running"); // leave it running for reruns
});
