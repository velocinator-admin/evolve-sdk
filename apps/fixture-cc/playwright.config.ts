import { TEST_PUBLIC_KEY_ENV, TEST_SECRET_KEY } from "@next-evolve/fake-cloud";
import { defineConfig } from "@playwright/test";
import { APP_URL, CLOUD_URL, HUMAN_UA, PORT } from "./e2e/env";

// T23.3: static mode with cacheComponents (next start). E2E_PORT_OFFSET moves the ports.
export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: APP_URL,
    userAgent: HUMAN_UA,
    launchOptions: { args: [`--user-agent=${HUMAN_UA}`] },
  },
  webServer: [
    {
      command: "pnpm --filter @next-evolve/fake-cloud start",
      url: `${CLOUD_URL}/health`,
      env: { FAKE_CLOUD_PORT: String(PORT.cloud) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `rm -rf .evolve-cache && mkdir -p .evolve-cache && pnpm exec next start --port ${PORT.app}`,
      url: `${APP_URL}/api/evolve/health`,
      env: {
        EVOLVE_CLOUD_URL: CLOUD_URL,
        EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
        EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
        EVOLVE_UNSAFE_ALLOW_TEST_KEY: "1",
        EVOLVE_POLL_SECONDS: "1",
        EVOLVE_CACHE_DIR: ".evolve-cache",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
