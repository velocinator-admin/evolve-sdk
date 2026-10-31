import { TEST_PUBLIC_KEY_ENV, TEST_SECRET_KEY } from "@next-evolve/fake-cloud";
import { defineConfig } from "@playwright/test";

const CLOUD = "http://127.0.0.1:4011";
export const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:3115", userAgent: HUMAN_UA },
  webServer: [
    {
      command: "pnpm --filter @next-evolve/fake-cloud start",
      url: `${CLOUD}/health`,
      env: { FAKE_CLOUD_PORT: "4011" },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "rm -rf .next/cache/fetch-cache && pnpm exec next start --port 3115",
      url: "http://localhost:3115/login",
      env: {
        EVOLVE_CLOUD_URL: CLOUD,
        EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
        EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
        EVOLVE_UNSAFE_ALLOW_TEST_KEY: "1",
        EVOLVE_POLL_SECONDS: "1",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
