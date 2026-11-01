import { type APIRequestContext, expect, test } from "@playwright/test";
import { CLOUD_URL, SYNC_APP_URL, SYNC_SITE } from "./env";

// T7.9: the sync app polls every 10 minutes, so a new bundle can only reach
// it quickly through the signed webhook. Ids differ from the M1 bundle's
// because both instances share one ISR cache directory.
const bundle = (wB: number) => ({
  site: SYNC_SITE,
  routing: {
    routes: { "/": ["s9y1n2"] },
    experiments: {
      s9y1n2: {
        status: "running",
        traffic: 1,
        control: "s9y1a0",
        variants: [
          { id: "s9y1a0", w: 1 - wB },
          { id: "s9y1b0", w: wB },
        ],
      },
    },
  },
  variants: {
    s9y1a0: { exp: "s9y1n2", region: "hero", ctrl: true, props: {} },
    s9y1b0: { exp: "s9y1n2", region: "hero", ctrl: false, props: { title: "Synced in seconds" } },
  },
});

const title = async (request: APIRequestContext) => {
  const res = await request.get(`${SYNC_APP_URL}/`, { headers: { cookie: "" } });
  return /data-testid="hero-title"[^>]*>([^<]*)</.exec(await res.text())?.[1] ?? "";
};

const publish = async (request: APIRequestContext, wB: number) => {
  const res = await request.post(`${CLOUD_URL}/__control/publish`, {
    data: { ...bundle(wB), notify: SYNC_APP_URL },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { ver: number; webhook: { status: number } };
};

test.describe.configure({ mode: "serial" });

test("a published change is live within 5 s through the webhook", async ({ request }) => {
  const first = await publish(request, 0);
  expect(first.webhook.status).toBe(202);
  await expect.poll(() => title(request), { timeout: 10_000 }).not.toBe("Synced in seconds");
  // Past the 5 s refresh window of the first webhook, so this measures the webhook alone.
  await new Promise((r) => setTimeout(r, 5_000));

  const t0 = Date.now();
  const second = await publish(request, 1);
  expect(second.webhook.status).toBe(202);
  await expect
    .poll(() => title(request), { timeout: 5_000, intervals: [100] })
    .toBe("Synced in seconds");
  test
    .info()
    .annotations.push({ type: "latency", description: `webhook → live in ${Date.now() - t0} ms` });
});

test("forged and replayed webhooks don't cause a bundle fetch", async ({ request }) => {
  const fetches = async () =>
    (
      (await (await request.get(`${CLOUD_URL}/__control/state`)).json()) as {
        calls: { path: string; site?: string }[];
      }
    ).calls.filter((c) => c.path === "/v1/bundle" && c.site === SYNC_SITE).length;
  const send = (data: object) =>
    request.post(`${CLOUD_URL}/__control/webhook`, {
      data: { appUrl: SYNC_APP_URL, site: SYNC_SITE, ...data },
    });
  const body = { pv: 1, type: "bundle.updated", site: SYNC_SITE, ver: 999, iat: 1 };
  // Settle anything in flight, then count.
  await new Promise((r) => setTimeout(r, 5_500));
  const before = await fetches();
  const forged = await (await send({ body, secret: `whsec_${"x".repeat(32)}` })).json();
  expect(forged.status).toBe(401);
  const ping = await (await send({ body: { pv: 1, type: "ping" } })).json();
  expect(ping.status).toBe(202);
  const replay = await (await send({ body, delivery: ping.delivery })).json();
  expect(replay.status).toBe(409);
  await new Promise((r) => setTimeout(r, 1_000));
  expect(await fetches()).toBe(before);
});
