import { expect, test } from "@playwright/test";
import { CLOUD_URL } from "./env";

type State = { calls: { path: string }[] };
const bundleFetches = async (request: import("@playwright/test").APIRequestContext) =>
  ((await (await request.get(`${CLOUD_URL}/__control/state`)).json()) as State).calls.filter(
    (c) => c.path === "/v1/bundle",
  ).length;

// T7.3 / spec §7.8: the proxy's bundle store is module state that persists
// across requests on `next start`. If it were rebuilt per request, every
// request would fetch the bundle; with persistence fetches follow the poll
// interval (1 s here) no matter how many requests come in.
test("proxy store persists across requests (fetches follow the poll interval)", async ({
  request,
}) => {
  const before = await bundleFetches(request);
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    const res = await request.get("/", { headers: { cookie: "" }, maxRedirects: 0 });
    expect(res.status()).toBe(200);
  }
  const seconds = (Date.now() - t0) / 1000;
  const fetches = (await bundleFetches(request)) - before;
  // ≤ 1 per second per store (proxy + render path), plus slack.
  expect(fetches).toBeLessThanOrEqual(Math.ceil(seconds) * 2 + 2);
  expect(fetches).toBeLessThan(30);
});
