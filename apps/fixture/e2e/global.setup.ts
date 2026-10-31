import { expect, test as setup } from "@playwright/test";
import { CLOUD_URL, M1_BUNDLE } from "./env";

setup("publish the M1 bundle and wait until the app serves it", async ({ request }) => {
  const pub = await request.post(`${CLOUD_URL}/__control/publish`, { data: M1_BUNDLE });
  expect(pub.ok()).toBe(true);
  // The app's store polls every second (EVOLVE_POLL_SECONDS=1). A bundle is
  // live once a new visitor gets an assignment cookie.
  await expect
    .poll(
      async () => {
        const res = await request.get("/", { headers: { cookie: "" }, maxRedirects: 0 });
        return res.headers()["set-cookie"] ?? "";
      },
      { timeout: 15_000, intervals: [250] },
    )
    .toContain("evolve_a=");
});
