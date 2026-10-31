import { defineConfig } from "@playwright/test";
import { APP_PORT, APP_URL, appEnv, CLOUD_PORT, CLOUD_URL, HUMAN_UA } from "./e2e/env";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: APP_URL,
    // Headless Chromium says "HeadlessChrome", which Evolve treats as a bot (control, no cookies).
    userAgent: HUMAN_UA,
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    { name: "chromium", dependencies: ["setup"], use: { browserName: "chromium" } },
  ],
  webServer: [
    {
      command: "pnpm --filter @next-evolve/fake-cloud start",
      url: `${CLOUD_URL}/health`,
      env: { FAKE_CLOUD_PORT: String(CLOUD_PORT) },
      reuseExistingServer: !process.env.CI,
    },
    {
      // Variant ids are reused across test runs with different props; drop runtime ISR entries.
      command: `rm -rf .next/server/route-cache && pnpm exec next start --port ${APP_PORT}`,
      url: APP_URL,
      env: appEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
