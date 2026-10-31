import { TEST_PUBLIC_KEY_ENV, TEST_SECRET_KEY, TEST_SITE } from "@next-evolve/fake-cloud";

export const CLOUD_PORT = 4010;
export const APP_PORT = 3100;
export const CLOUD_URL = `http://127.0.0.1:${CLOUD_PORT}`;
export const APP_URL = `http://localhost:${APP_PORT}`;
export { TEST_SITE };

export const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Env for the fixture app when it runs against the fake cloud. */
export const appEnv = {
  EVOLVE_CLOUD_URL: CLOUD_URL,
  EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
  EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
  // `next start` runs with NODE_ENV=production; allow the test key explicitly.
  EVOLVE_UNSAFE_ALLOW_TEST_KEY: "1",
  EVOLVE_POLL_SECONDS: "1",
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
