import { expect, test } from "@playwright/test";

// T21.1 (D77): the bundle's `/lp/:slug` experiment serves on every /lp/<slug>,
// statically from app/[evolve]/lp/[slug] (one cached page per slug and variant).
for (const slug of ["a", "b"]) {
  test(`pattern route /lp/:slug serves the variant on /lp/${slug}`, async ({ page }) => {
    const res = await page.goto(`/lp/${slug}`);
    expect(res!.status()).toBe(200);
    await expect(page.getByTestId("slug")).toHaveText(slug);
    await expect(page.getByTestId("hero-title")).toHaveText("Landing variant");
    await expect(page.locator('[data-evolve-e="l1p2a3"]')).toHaveAttribute(
      "data-evolve-v",
      "ld0000",
    );
  });
}

test("a path outside the pattern isn't an Evolve route", async ({ request }) => {
  const res = await request.get("/lp/a/b", { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  expect(res.headers()["set-cookie"] ?? "").not.toContain("evolve_");
});
