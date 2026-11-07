import { describe, expect, it } from "vitest";
import { sampleBundle } from "../test/samples";
import {
  type BundlePayload,
  bundlePayloadSchema,
  computeBundleHash,
  computeContentHash,
} from "./bundle";
import { condSchema, MAX_RULES_PER_BUNDLE, MAX_RULES_PER_EXPERIMENT, ruleSchema } from "./rules";

type Rules = NonNullable<BundlePayload["rules"]>;
const rule = (over: Partial<Rules[number]> = {}): Rules[number] => ({
  id: "r1s2t3",
  exp: "k3j9x2",
  var: "c1d2e3",
  when: [{ f: "utm_campaign", op: "eq", v: "spring-sale" }],
  ...over,
});
const withRules = (rules: unknown[]) => ({ ...sampleBundle(), rules }) as BundlePayload;

describe("condSchema (writer side)", () => {
  const ok: unknown[] = [
    { f: "utm_source", op: "eq", v: "google" },
    { f: "utm_medium", op: "prefix", v: "cp" },
    { f: "utm_campaign", op: "in", v: ["a", "b"] },
    { f: "utm_term", op: "re", v: "^shoes?$" },
    { f: "utm_content", op: "eq", v: "x" },
    { f: "ref", op: "eq", v: "news.ycombinator.com" },
    { f: "country", op: "in", v: ["US", "CA"] },
    { f: "country", op: "re", v: "^(US|CA)$" },
    { f: "device", op: "eq", v: "mobile" },
    { f: "device", op: "in", v: ["tablet", "desktop"] },
  ];
  for (const c of ok)
    it(`accepts ${JSON.stringify(c)}`, () => expect(condSchema.parse(c)).toEqual(c));

  const bad: [string, unknown][] = [
    ["unknown field", { f: "lang", op: "eq", v: "en" }],
    ["unknown op", { f: "ref", op: "contains", v: "x" }],
    ["in with a string", { f: "ref", op: "in", v: "x" }],
    ["eq with an array", { f: "ref", op: "eq", v: ["x"] }],
    ["empty value", { f: "ref", op: "eq", v: "" }],
    ["value too long", { f: "ref", op: "eq", v: "x".repeat(201) }],
    ["invalid regex", { f: "utm_source", op: "re", v: "(" }],
    ["regex too long", { f: "utm_source", op: "re", v: "a".repeat(201) }],
    ["unknown device", { f: "device", op: "eq", v: "watch" }],
    ["lowercase country", { f: "country", op: "eq", v: "us" }],
    ["too many in values", { f: "ref", op: "in", v: Array.from({ length: 51 }, (_, i) => `${i}`) }],
  ];
  for (const [name, c] of bad)
    it(`rejects: ${name}`, () => expect(condSchema.safeParse(c).success).toBe(false));

  it("ruleSchema needs at least one condition and valid ids", () => {
    expect(ruleSchema.safeParse(rule()).success).toBe(true);
    expect(ruleSchema.safeParse(rule({ when: [] })).success).toBe(false);
    expect(ruleSchema.safeParse(rule({ id: "BAD" })).success).toBe(false);
  });
});

describe("bundle rules (reader side)", () => {
  it("accepts a bundle with rules", () => {
    const r = bundlePayloadSchema.safeParse(withRules([rule()]));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.data?.rules).toEqual([rule()]);
  });

  it("a bundle without rules has no rules field", () => {
    expect(bundlePayloadSchema.parse(sampleBundle()).rules).toBeUndefined();
  });

  it("tolerates fields and operators a later minor may add (the evaluator skips them)", () => {
    const r = rule({ when: [{ f: "lang", op: "eq", v: "en" }] });
    expect(bundlePayloadSchema.safeParse(withRules([r])).success).toBe(true);
  });

  const invalid: [string, () => unknown[]][] = [
    ["unknown experiment", () => [rule({ exp: "zzzzzz" })]],
    ["variant of another experiment", () => [rule({ var: "zzzzzz" })]],
    ["control id of the wrong experiment", () => [rule({ var: "k3j9x2" })]],
    ["duplicate rule id", () => [rule(), rule()]],
    ["no conditions", () => [rule({ when: [] })]],
    ["value too long", () => [rule({ when: [{ f: "ref", op: "eq", v: "x".repeat(201) }] })]],
    ["bad rule id", () => [rule({ id: "nope" })]],
    [
      `more than ${MAX_RULES_PER_EXPERIMENT} rules for one experiment`,
      () =>
        Array.from({ length: MAX_RULES_PER_EXPERIMENT + 1 }, (_, i) =>
          rule({ id: `r${String(i).padStart(5, "0")}` }),
        ),
    ],
    [
      `more than ${MAX_RULES_PER_BUNDLE} rules`,
      () =>
        Array.from({ length: MAX_RULES_PER_BUNDLE + 1 }, (_, i) =>
          rule({ id: `r${String(i).padStart(5, "0")}` }),
        ),
    ],
    ["not an array", () => ({ x: 1 }) as never],
  ];
  for (const [name, rules] of invalid) {
    it(`rejects: ${name}`, () => {
      expect(bundlePayloadSchema.safeParse(withRules(rules())).success).toBe(false);
    });
  }

  it("rejects a rule for an experiment that isn't running", () => {
    const b = withRules([rule()]);
    b.routing.experiments.k3j9x2!.status = "completed";
    b.routing.experiments.k3j9x2!.winner = "c1d2e3";
    expect(bundlePayloadSchema.safeParse(b).success).toBe(false);
  });

  it(`accepts exactly ${MAX_RULES_PER_EXPERIMENT} rules for one experiment`, () => {
    const rules = Array.from({ length: MAX_RULES_PER_EXPERIMENT }, (_, i) =>
      rule({ id: `r${String(i).padStart(5, "0")}` }),
    );
    expect(bundlePayloadSchema.safeParse(withRules(rules)).success).toBe(true);
  });
});

describe("hashes", () => {
  it("a bundle without rules hashes as before 1.3.0 (fixed vector)", () => {
    const b = sampleBundle();
    expect(computeBundleHash(b)).toBe(FIXED);
    expect(computeContentHash(b)).toBe(FIXED);
  });

  it("the signed hash ignores rules; the content hash covers them", () => {
    const a = withRules([rule()]);
    const b = withRules([rule({ when: [{ f: "utm_campaign", op: "eq", v: "summer" }] })]);
    expect(computeBundleHash(a)).toBe(FIXED);
    expect(computeBundleHash(b)).toBe(FIXED);
    expect(computeContentHash(a)).not.toBe(FIXED);
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
    expect(computeContentHash(withRules([]))).not.toBe(FIXED);
  });
});

/** computeBundleHash(sampleBundle()) as @next-evolve/protocol 1.0.0 computes it. */
const FIXED = "992fac771d153074a09991b16e81b4f4c87729a5a14bee77ec1218f5f5d31564";
