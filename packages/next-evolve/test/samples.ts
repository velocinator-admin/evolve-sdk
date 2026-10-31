import { type BundlePayload, computeBundleHash } from "@next-evolve/protocol";

/** Valid bundle: "/" runs hero test k3j9x2 (A/B 50/50); "/pricing" adds a completed test. */
export function sampleBundle(mutate?: (b: BundlePayload) => void): BundlePayload {
  const iat = Math.floor(Date.now() / 1000) - 60;
  const b: BundlePayload = {
    pv: 1,
    site: "site_ab12cd34ef",
    ver: 3,
    iat,
    exp: iat + 14 * 86_400,
    hash: "",
    routing: {
      routes: { "/": ["k3j9x2"], "/pricing": ["k3j9x2", "p7q8r9"] },
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
          status: "completed",
          traffic: 1,
          control: "m1n2o3",
          winner: "s4t5u6",
          variants: [
            { id: "m1n2o3", w: 0.5 },
            { id: "s4t5u6", w: 0.5 },
          ],
        },
      },
    },
    variants: {
      a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
      c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "Ship 10x faster" } },
      m1n2o3: { exp: "p7q8r9", region: "pricing-cta", ctrl: true, props: {} },
      s4t5u6: {
        exp: "p7q8r9",
        region: "pricing-cta",
        ctrl: false,
        props: { label: "Start free trial" },
      },
    },
  };
  mutate?.(b);
  b.hash = computeBundleHash(b);
  return b;
}
