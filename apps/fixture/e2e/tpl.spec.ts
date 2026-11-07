import { expect, test } from "@playwright/test";
import { HUMAN_UA } from "./env";

// M24 / TPL-1 (T29.1, T29.2): `/:name([A-Z][A-Za-z]*-[A-Za-z-]+)` serves its
// experiment on person pages, statically from app/[evolve]/[name], and fills
// `{name}` (route param) and `{fullName}` (<Optimizable vars>) per page.
test.use({ userAgent: HUMAN_UA });

for (const name of ["Christopher-G", "Mary-Ann-Smith"]) {
  test(`person page /${name} serves the templated variant`, async ({ page }) => {
    const res = await page.goto(`/${name}`);
    expect(res!.status()).toBe(200);
    await expect(page.getByTestId("person")).toHaveText(name);
    await expect(page.getByTestId("hero-title")).toHaveText(`Hire ${name} today`);
    await expect(page.getByTestId("hero-cta")).toHaveText(`Meet ${name.replace(/-/g, " ")}`);
    const marker = page.locator('[data-evolve-e="t1p2l3"]');
    await expect(marker).toHaveAttribute("data-evolve-v", "pv0001");
    await expect(marker).not.toHaveAttribute("data-evolve-x", "");
  });
}

test("a page without a var the variant needs renders control, uncounted", async ({ page }) => {
  await page.goto("/No-Profile");
  await expect(page.getByTestId("hero-title")).toHaveText("Meet No-Profile");
  const marker = page.locator('[data-evolve-e="t1p2l3"]');
  await expect(marker).toHaveAttribute("data-evolve-x", "");
});

test("/pricing keeps its own experiment; the constraint doesn't catch it", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.locator('[data-evolve-e="t1p2l3"]')).toHaveCount(0);
  await expect(page.locator('[data-evolve-e="p7q8r9"]')).toHaveCount(1);
});

test("a lowercase name isn't an Evolve route", async ({ request }) => {
  const res = await request.get("/christopher-g", { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  expect(res.headers()["set-cookie"] ?? "").not.toContain("evolve_");
});
