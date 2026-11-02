import {
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
  TEST_WEBHOOK_SECRET,
} from "@next-evolve/fake-cloud";

export const CLOUD_PORT = 4010;
export const APP_PORT = 3100;
export const CLOUD_URL = `http://127.0.0.1:${CLOUD_PORT}`;
export const APP_URL = `http://localhost:${APP_PORT}`;

/**
 * A second instance of the fixture for another site that polls every 10 min,
 * so only the sync webhook can bring it a new bundle quickly (T7.9).
 */
export const SYNC_APP_PORT = 3101;
export const SYNC_APP_URL = `http://localhost:${SYNC_APP_PORT}`;
export const SYNC_SITE = "site_fakesync01";
export { TEST_SECRET_KEY, TEST_SITE, TEST_WEBHOOK_SECRET };

export const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Customer DB (docker compose in the repo root). */
export const DB_URL =
  process.env.EVOLVE_DATABASE_URL ?? "postgres://evolve:evolve@localhost:54329/customer";
export const TRACK_SECRET = "trk_fixture_e2e";

/** Env for the fixture app when it runs against the fake cloud. */
export const appEnv = {
  EVOLVE_DATABASE_URL: DB_URL,
  EVOLVE_TRACK_SECRET: TRACK_SECRET,
  EVOLVE_CLOUD_URL: CLOUD_URL,
  EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
  EVOLVE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
  // `next start` runs with NODE_ENV=production; allow the test key explicitly.
  EVOLVE_UNSAFE_ALLOW_TEST_KEY: "1",
  EVOLVE_POLL_SECONDS: "1",
  // The fake cloud restarts at ver 1; a disk cache from an earlier run would look newer.
  EVOLVE_CACHE_DIR: ".evolve-cache/main",
};

export const syncAppEnv = {
  ...appEnv,
  EVOLVE_SECRET_KEY: `evk_live_${SYNC_SITE}_${"S".repeat(32)}`,
  EVOLVE_POLL_SECONDS: "600",
  EVOLVE_CACHE_DIR: ".evolve-cache/sync",
};

/**
 * Failure drills (spec §18 scenarios 9 and 12), each on its own instance and site
 * so toggling the cloud or the clock never affects the other specs.
 * - edge: a normal app; tests cut its site off the cloud and let bundles expire.
 * - offline: boots with its site unreachable on the fake cloud (FAKE_CLOUD_DOWN_SITES)
 *   and a customer DB URL that nothing listens on.
 */
export const EDGE_APP_PORT = 3102;
export const EDGE_APP_URL = `http://localhost:${EDGE_APP_PORT}`;
export const EDGE_SITE = "site_fakeedge01";
export const OFFLINE_APP_PORT = 3103;
export const OFFLINE_APP_URL = `http://localhost:${OFFLINE_APP_PORT}`;
export const OFFLINE_SITE = "site_fakeoffl01";
export const DEAD_DB_URL = "postgres://evolve:evolve@127.0.0.1:1/customer";

export const edgeAppEnv = {
  ...appEnv,
  EVOLVE_SECRET_KEY: `evk_live_${EDGE_SITE}_${"E".repeat(32)}`,
  EVOLVE_CACHE_DIR: ".evolve-cache/edge",
};

export const offlineAppEnv = {
  ...appEnv,
  EVOLVE_SECRET_KEY: `evk_live_${OFFLINE_SITE}_${"O".repeat(32)}`,
  EVOLVE_DATABASE_URL: DEAD_DB_URL,
  EVOLVE_CACHE_DIR: ".evolve-cache/offline",
};

/** Hero test on "/" (A = control, B = new headline) and a pricing CTA test. */
export const M1_BUNDLE = {
  site: TEST_SITE,
  routing: {
    routes: { "/": ["k3j9x2"], "/pricing": ["p7q8r9"], "/features": ["f5e6a7"] },
    experiments: {
      k3j9x2: {
        status: "running",
        traffic: 1,
        control: "a8f2l1",
        variants: [
          { id: "a8f2l1", w: 0.5 },
          { id: "c1d2e3", w: 0.5 },
        ],
      },
      f5e6a7: {
        status: "running",
        traffic: 1,
        control: "fa0000",
        variants: [
          { id: "fa0000", w: 0.5 },
          { id: "fb0000", w: 0.5 },
        ],
      },
      p7q8r9: {
        status: "running",
        traffic: 1,
        control: "m1n2o3",
        variants: [
          { id: "m1n2o3", w: 0.5 },
          { id: "s4t5u6", w: 0.5 },
        ],
      },
    },
  },
  variants: {
    a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
    c1d2e3: {
      exp: "k3j9x2",
      region: "hero",
      ctrl: false,
      props: { title: "Ship 10x faster", subtitle: "From idea to production in a day" },
    },
    fa0000: { exp: "f5e6a7", region: "features-hero", ctrl: true, props: {} },
    fb0000: {
      exp: "f5e6a7",
      region: "features-hero",
      ctrl: false,
      props: { title: "All the tools, none of the flicker" },
    },
    m1n2o3: { exp: "p7q8r9", region: "pricing-cta", ctrl: true, props: {} },
    s4t5u6: {
      exp: "p7q8r9",
      region: "pricing-cta",
      ctrl: false,
      props: { label: "Start free trial" },
    },
  },
};

/**
 * T12.5: a production build (`next start`) given the test public key WITHOUT
 * EVOLVE_UNSAFE_ALLOW_TEST_KEY. It must reject every bundle the fake cloud signs.
 */
export const PRODKEY_APP_PORT = 3106;
export const PRODKEY_APP_URL = `http://localhost:${PRODKEY_APP_PORT}`;
export const PRODKEY_SITE = "site_fakeprodk1";
const { EVOLVE_UNSAFE_ALLOW_TEST_KEY: _allow, ...withoutOptIn } = appEnv;
export const prodkeyAppEnv = {
  ...withoutOptIn,
  EVOLVE_SECRET_KEY: `evk_live_${PRODKEY_SITE}_${"P".repeat(32)}`,
  EVOLVE_CACHE_DIR: ".evolve-cache/prodkey",
};
