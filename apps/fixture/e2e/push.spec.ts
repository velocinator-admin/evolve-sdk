import { expect, test } from "@playwright/test";
import { CLOUD_URL, TEST_SITE } from "./env";

type State = {
  manifests: Record<string, { routes: Record<string, unknown>; goals: Record<string, unknown> }>;
  regions: Record<string, Record<string, { path: string; controlProps: Record<string, unknown> }>>;
};
const state = async (request: import("@playwright/test").APIRequestContext) =>
  (await (await request.get(`${CLOUD_URL}/__control/state`)).json()) as State;

// T6.7: the app pushes its manifest at startup (registerEvolve) and registers
// each region after rendering it. Configuration only, no visitor data.
test("manifest and regions reach the cloud", async ({ request }) => {
  // registerEvolve pushes in the background (0.5.1), so poll for it.
  await expect
    .poll(
      async () => Object.keys((await state(request)).manifests[TEST_SITE]?.routes ?? {}).sort(),
      {
        timeout: 10_000,
      },
    )
    .toEqual([
      "/",
      "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)",
      "/features",
      "/lp/:slug",
      "/pricing",
      "/slow",
    ]);
  const m = (await state(request)).manifests[TEST_SITE];
  expect(Object.keys(m?.goals ?? {}).length).toBeGreaterThan(0);

  await request.get("/");
  await request.get("/features");
  await expect
    .poll(async () => Object.keys((await state(request)).regions[TEST_SITE] ?? {}).sort(), {
      timeout: 10_000,
    })
    .toEqual(expect.arrayContaining(["features-hero", "hero"]));
  const hero = (await state(request)).regions[TEST_SITE]!.hero!;
  expect(hero.path).toBe("/");
  expect(hero.controlProps).toMatchObject({
    title: "Ship faster",
    cta: "Start free",
  });
});
