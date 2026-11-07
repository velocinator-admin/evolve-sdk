import { defineConfig } from "@playwright/test";
import {
  APP_HOST,
  APP_PORT,
  APP_URL,
  appEnv,
  CDN_APP_PORT,
  CDN_APP_URL,
  CLOUD_PORT,
  CLOUD_URL,
  cdnAppEnv,
  DOCKER_CONTAINER,
  DOCKER_IMAGE,
  EDGE_APP_PORT,
  EDGE_APP_URL,
  edgeAppEnv,
  HUMAN_UA,
  OFFLINE_APP_PORT,
  OFFLINE_APP_URL,
  OFFLINE_SITE,
  offlineAppEnv,
  PRODKEY_APP_PORT,
  PRODKEY_APP_URL,
  prodkeyAppEnv,
  SYNC_APP_PORT,
  SYNC_APP_URL,
  syncAppEnv,
} from "./e2e/env";

/**
 * T23.1: the main instance as a container from the standalone image. It reaches
 * the fake cloud and the customer DB on the host through host.docker.internal
 * (the fake cloud listens on 0.0.0.0 for it). Playwright may SIGKILL the
 * `docker run` client, which leaves the container running, so
 * e2e/global.teardown.ts removes it.
 */
function dockerApp(env: Record<string, string>) {
  const toHost = (u: string) =>
    u.replace(/(\/\/|@)(localhost|127\.0\.0\.1)(?=[:/])/, "$1host.docker.internal");
  const container = {
    ...env,
    EVOLVE_CLOUD_URL: toHost(env.EVOLVE_CLOUD_URL!),
    EVOLVE_DATABASE_URL: toHost(env.EVOLVE_DATABASE_URL!),
  };
  delete (container as Record<string, string | undefined>).EVOLVE_CACHE_DIR;
  const flags = Object.keys(container)
    .map((k) => `-e ${k}`)
    .join(" ");
  const name = DOCKER_CONTAINER;
  return {
    command: `docker rm -f ${name} >/dev/null 2>&1; exec docker run --rm --init --name ${name} -p ${APP_PORT}:3000 --add-host=host.docker.internal:host-gateway ${flags} ${DOCKER_IMAGE}`,
    url: APP_URL,
    env: container,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  };
}

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  globalTeardown: "./e2e/global.teardown.ts",
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
      env: {
        FAKE_CLOUD_PORT: String(CLOUD_PORT),
        FAKE_CLOUD_DOWN_SITES: OFFLINE_SITE,
        ...(APP_HOST === "docker" ? { FAKE_CLOUD_HOST: "0.0.0.0" } : {}),
      },
      reuseExistingServer: !process.env.CI,
    },
    APP_HOST === "docker"
      ? dockerApp(appEnv)
      : {
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
        ["prodkey", PRODKEY_APP_PORT, PRODKEY_APP_URL, prodkeyAppEnv],
        ["cdn", CDN_APP_PORT, CDN_APP_URL, cdnAppEnv],
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
