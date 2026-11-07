import { TEST_SITE } from "@next-evolve/fake-cloud";

const OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0);
export const PORT = { app: 3125 + OFFSET, cloud: 4012 + OFFSET };
export const APP_URL = `http://localhost:${PORT.app}`;
export const CLOUD_URL = `http://127.0.0.1:${PORT.cloud}`;
export const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Hero test on "/" (A = control, B = new headline) and a pricing CTA test. */
export const BUNDLE = {
  site: TEST_SITE,
  routing: {
    routes: { "/": ["k3j9x2"], "/pricing": ["p7q8r9"] },
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
    c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "Cached per code" } },
    m1n2o3: { exp: "p7q8r9", region: "pricing-cta", ctrl: true, props: {} },
    s4t5u6: {
      exp: "p7q8r9",
      region: "pricing-cta",
      ctrl: false,
      props: { label: "Start free trial" },
    },
  },
};
