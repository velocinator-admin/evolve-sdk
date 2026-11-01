import { defineConfig } from "@playwright/test";
import {
  APP_PORT,
  APP_URL,
  appEnv,
  CLOUD_PORT,
  CLOUD_URL,
  EDGE_APP_PORT,
  EDGE_APP_URL,
  edgeAppEnv,
  HUMAN_UA,
  OFFLINE_APP_PORT,
  OFFLINE_APP_URL,
  OFFLINE_SITE,
  offlineAppEnv,
  SYNC_APP_PORT,
  SYNC_APP_URL,
  syncAppEnv,
} from "./e2e/env";

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
    {
      name: "chromium",
      dependencies: ["setup"],
      use: {
        browserName: "chromium",
        launchOptions: {
          args: [
            // The beacon is off when navigator.webdriver is set; this flag clears it.
            "--disable-blink-features=AutomationControlled",
            // Beacons sent while a page unloads ignore Playwright's per-context UA and
            // say "HeadlessChrome" (a bot to Evolve); set the UA browser-wide too.
            `--user-agent=${HUMAN_UA}`,
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @next-evolve/fake-cloud start",
      url: `${CLOUD_URL}/health`,
      env: { FAKE_CLOUD_PORT: String(CLOUD_PORT), FAKE_CLOUD_DOWN_SITES: OFFLINE_SITE },
      reuseExistingServer: !process.env.CI,
    },
    {
      // Variant ids are reused across test runs with different props; drop runtime ISR entries.
      command: `rm -rf .next/server/route-cache .evolve-cache/main && mkdir -p .evolve-cache/main && pnpm exec next start --port ${APP_PORT}`,
      url: APP_URL,
      env: appEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `rm -rf .evolve-cache/sync && mkdir -p .evolve-cache/sync && pnpm exec next start --port ${SYNC_APP_PORT}`,
      url: SYNC_APP_URL,
      env: syncAppEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    ...(
      [
        ["edge", EDGE_APP_PORT, EDGE_APP_URL, edgeAppEnv],
        ["offline", OFFLINE_APP_PORT, OFFLINE_APP_URL, offlineAppEnv],
      ] as const
    ).map(([dir, port, url, env]) => ({
      command: `rm -rf .evolve-cache/${dir} && mkdir -p .evolve-cache/${dir} && pnpm exec next start --port ${port}`,
      url,
      env,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    })),
  ],
});
