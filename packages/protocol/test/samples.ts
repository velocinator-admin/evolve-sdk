import type { BundlePayload } from "../src/bundle";

/** A valid two-variant bundle for site_ab12cd34ef: hero test on "/". */
export function sampleBundle(overrides: Partial<BundlePayload> = {}): BundlePayload {
  const iat = 1_790_000_000;
  return {
    pv: 1,
    site: "site_ab12cd34ef",
    ver: 3,
    iat,
    exp: iat + 14 * 86_400,
    hash: "",
    routing: {
      routes: { "/": ["k3j9x2"] },
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
      },
    },
    variants: {
      a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
      c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "Ship 10x faster" } },
    },
    ...overrides,
  };
}
