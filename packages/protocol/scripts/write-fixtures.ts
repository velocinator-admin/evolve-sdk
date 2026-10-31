// Regenerates fixtures/v1/*.json. Run: pnpm --filter @next-evolve/protocol fixtures
import { writeFileSync } from "node:fs";
import { computeBundleHash } from "../src/bundle";

const dir = new URL("../fixtures/v1/", import.meta.url);
const write = (name: string, value: unknown) =>
  writeFileSync(new URL(name, dir), `${JSON.stringify(value, null, 2)}\n`);

const iat = 1_795_000_000;
const routing = {
  routes: { "/": ["k3j9x2"], "/pricing": ["k3j9x2", "p7q8r9"] },
  experiments: {
    k3j9x2: {
      status: "running",
      traffic: 0.8,
      control: "a8f2l1",
      variants: [
        { id: "a8f2l1", w: 0.34 },
        { id: "c1d2e3", w: 0.33 },
        { id: "f4g5h6", w: 0.33 },
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
};
const variants = {
  a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
  c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "Ship 10x faster" } },
  f4g5h6: {
    exp: "k3j9x2",
    region: "hero",
    ctrl: false,
    props: { title: "Launch today", cta: "Try it" },
  },
  m1n2o3: { exp: "p7q8r9", region: "pricing-cta", ctrl: true, props: {} },
  s4t5u6: {
    exp: "p7q8r9",
    region: "pricing-cta",
    ctrl: false,
    props: { label: "Start free trial" },
  },
};
write("bundle-payload.json", {
  pv: 1,
  site: "site_ab12cd34ef",
  ver: 12,
  iat,
  exp: iat + 14 * 86_400,
  hash: computeBundleHash({ routing, variants } as never),
  routing,
  variants,
});

write("webhook-bundle-updated.json", {
  pv: 1,
  type: "bundle.updated",
  site: "site_ab12cd34ef",
  ver: 12,
  iat,
});
write("webhook-ping.json", { pv: 1, type: "ping" });

const goal = (event: string, extra = {}) => ({
  kind: "event",
  event,
  window: "7d",
  unit: "visitor",
  source: null,
  where: null,
  value: null,
  direction: "increase",
  ...extra,
});
write("aggregate-request.json", {
  type: "aggregate.request",
  pv: 1,
  requestId: "agr_7f3kq9w2m4x8z1c5v6b7n0aa",
  site: "site_ab12cd34ef",
  asOf: "2026-12-01T10:00:00Z",
  mode: "incremental",
  experiments: [
    {
      id: "k3j9x2",
      variants: ["a8f2l1", "c1d2e3", "f4g5h6"],
      cohortsFrom: "2026-11-20",
      goals: [
        { key: "signed_up", role: "primary", hash: "3f1a", def: goal("signed_up") },
        {
          key: "paid",
          role: "secondary",
          hash: "9b2c",
          def: goal("subscription_started", {
            window: "30d",
            source: "stripe",
            value: { kind: "local-fn" },
          }),
        },
        {
          key: "signup_page",
          role: "secondary",
          hash: "77de",
          def: {
            kind: "pageview",
            path: "/signup",
            window: "1d",
            unit: "visitor",
            value: null,
            direction: "increase",
          },
        },
      ],
    },
  ],
  usageFrom: "2026-11-30",
});

const r = (v: string, goalKey: string, day: string, n: number, c: number, s1 = 0, s2 = 0) => ({
  exp: "k3j9x2",
  var: v,
  goal: goalKey,
  seg: "main",
  day,
  n,
  c,
  s1,
  s2,
  mn: n,
  mc: c,
  ms1: s1,
  ms2: s2,
});
write("aggregate-response.json", {
  pv: 1,
  requestId: "agr_7f3kq9w2m4x8z1c5v6b7n0aa",
  site: "site_ab12cd34ef",
  asOf: "2026-12-01T10:00:00Z",
  sdk: "0.1.0",
  mode: "incremental",
  durationMs: 812,
  partial: false,
  remaining: [],
  rows: [
    r("a8f2l1", "signed_up", "2026-11-20", 412, 19),
    r("c1d2e3", "signed_up", "2026-11-20", 405, 27),
    r("f4g5h6", "signed_up", "2026-11-20", 398, 22),
    r("a8f2l1", "paid", "2026-11-20", 412, 3, 147, 7203),
    r("c1d2e3", "paid", "2026-11-20", 405, 5, 245, 12005),
  ],
  usage: [{ day: "2026-11-30", testedPageviews: 5120 }],
  errors: [],
});
