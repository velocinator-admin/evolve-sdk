import { TEST_SITE } from "@next-evolve/fake-cloud";
import { expect, test } from "@playwright/test";

const bundle = {
  site: TEST_SITE,
  routing: {
    routes: { "/": ["k3j9x2"] },
    experiments: {
      k3j9x2: {
        status: "running",
        traffic: 1,
        control: "a8f2l1",
        variants: [
          { id: "a8f2l1", w: 0.5 },
          { id: "c1d2e3", w: 0.5 },
        ],
      },
    },
  },
  variants: {
    a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
    c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "Next 15.5 variant" } },
  },
};

test.beforeAll(async ({ request }) => {
  expect(
    (await request.post("http://127.0.0.1:4011/__control/publish", { data: bundle })).ok(),
  ).toBe(true);
  await expect
    .poll(
      async () =>
        (await request.get("/", { headers: { cookie: "" } })).headers()["set-cookie"] ?? "",
      {
        timeout: 15_000,
      },
    )
    .toContain("evolve_a=");
});

test("Next 15.5 middleware serves a variant", async ({ request }) => {
  const html = await (
    await request.get("/", { headers: { cookie: "evolve_a=k3j9x2:c1d2e3" } })
  ).text();
  expect(html).toContain("Next 15.5 variant");
  expect(html).toContain('data-evolve-v="c1d2e3"');
});

test("the existing auth check still runs next to applyEvolve", async ({ request }) => {
  const res = await request.get("/app", { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers().location).toMatch(/\/login$/);
  const ok = await request.get("/app", { headers: { cookie: "session=1" } });
  expect(await ok.text()).toContain("Dashboard");
});

test("direct /ev_* is a 404 under middleware too", async ({ request }) => {
  expect((await request.get("/ev_0")).status()).toBe(404);
});
