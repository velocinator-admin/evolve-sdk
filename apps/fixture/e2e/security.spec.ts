import { expect, test } from "@playwright/test";
import { CLOUD_URL, HUMAN_UA, M1_BUNDLE, PRODKEY_APP_URL, PRODKEY_SITE } from "./env";

// T12.5: a production build never trusts the test signing key unless the
// operator opts in with EVOLVE_UNSAFE_ALLOW_TEST_KEY=1. The `prodkey` instance
// runs `next start` (NODE_ENV=production) with EVOLVE_UNSAFE_TEST_PUBLIC_KEY
// set and no opt-in; scenario 9's `edge` instance (same env plus the opt-in)
// is the positive twin that does get assigned.
test("a production build rejects bundles signed with the test key", async ({ request }) => {
  const bundle = {
    ...M1_BUNDLE,
    site: PRODKEY_SITE,
    routing: {
      ...M1_BUNDLE.routing,
      experiments: {
        ...M1_BUNDLE.routing.experiments,
        k3j9x2: {
          ...M1_BUNDLE.routing.experiments.k3j9x2,
          variants: [
            { id: "a8f2l1", w: 0 },
            { id: "c1d2e3", w: 1 },
          ],
        },
      },
    },
  };
  expect((await request.post(`${CLOUD_URL}/__control/publish`, { data: bundle })).ok()).toBe(true);
  await new Promise((r) => setTimeout(r, 4_000)); // several 1 s polls

  for (let i = 0; i < 5; i++) {
    const res = await fetch(PRODKEY_APP_URL, { headers: { "user-agent": HUMAN_UA } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("evolve_");
    expect(/data-testid="hero-title">([^<]+)</.exec(html)?.[1]).toBe("Ship faster");
    expect(html).not.toContain('data-evolve-e="k3j9x2"');
  }
  // The sync webhook can't install it either.
  const sync = await request.post(`${CLOUD_URL}/__control/webhook`, {
    data: { appUrl: PRODKEY_APP_URL, site: PRODKEY_SITE },
  });
  expect(sync.ok()).toBe(true);
  await new Promise((r) => setTimeout(r, 1_000));
  const after = await fetch(PRODKEY_APP_URL, { headers: { "user-agent": HUMAN_UA } });
  expect(after.headers.get("set-cookie") ?? "").not.toContain("evolve_");
});
