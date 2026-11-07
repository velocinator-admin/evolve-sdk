import { defineConfig } from "@playwright/test";
import { HUMAN_UA } from "./e2e/env";

/**
 * T23.2 host matrix: smoke checks against an already-deployed fixture
 * (`HOST_URL`, default the production fixture on Vercel). Nothing is started
 * and nothing is published: the checks hold for whatever bundle the site has.
 *   HOST_URL=https://fixture.evolveab.com pnpm --filter fixture test:e2e:host
 */
export default defineConfig({
  testDir: "e2e-host",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.HOST_URL ?? "https://fixture.evolveab.com",
    userAgent: HUMAN_UA,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
