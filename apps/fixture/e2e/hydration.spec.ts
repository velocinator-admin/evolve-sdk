import { expect, test } from "@playwright/test";

test("next-evolve client component hydrates", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-evolve", "ready");
});
