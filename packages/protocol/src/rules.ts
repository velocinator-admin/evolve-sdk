import { z } from "zod";
import { ID_RE } from "./ids";

// UTM rules (protocol 1.3.0, D75): "visitors matching these conditions see
// variant V of experiment E". Optional top-level bundle field `rules`, in
// dashboard order; all conditions of a rule must hold (AND); the first
// matching rule per experiment wins. Old readers ignore the field and serve
// the normal assignment, which is the safe fallback.

/** Request fields a condition can test. */
export const RULE_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  /** Referrer host: no scheme, no port, no leading `www.`. */
  "ref",
  /** ISO-3166 alpha-2 from the host's geo header (`geoHeader`, default `x-vercel-ip-country`). */
  "country",
  /** `mobile` | `tablet` | `desktop`, from the user agent. */
  "device",
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

/** `eq` and `prefix` take a string, `in` an array, `re` a regular expression source. */
export const RULE_OPS = ["eq", "in", "prefix", "re"] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const DEVICE_CLASSES = ["mobile", "tablet", "desktop"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const MAX_RULES_PER_EXPERIMENT = 20;
export const MAX_RULES_PER_BUNDLE = 50;
export const MAX_CONDITIONS_PER_RULE = 10;
/** Longest condition value (and regex source), in characters. */
export const MAX_RULE_VALUE_LENGTH = 200;
/** Most values in one `in` condition. */
export const MAX_RULE_IN_VALUES = 50;

const id = z.string().regex(ID_RE);
const value = z.string().max(MAX_RULE_VALUE_LENGTH);

/**
 * Condition as readers accept it. `f` and `op` are open strings so a later
 * minor can add fields or operators without old readers rejecting the whole
 * bundle: an evaluator treats a condition it doesn't know as "no match", which
 * skips that rule. Writers validate with {@link ruleSchema} (closed sets).
 */
const condReaderSchema = z.looseObject({
  f: z.string().min(1).max(32),
  op: z.string().min(1).max(16),
  v: z.union([value, z.array(value).min(1).max(MAX_RULE_IN_VALUES)]),
});

export const ruleReaderSchema = z.looseObject({
  id,
  exp: id,
  var: id,
  when: z.array(condReaderSchema).min(1).max(MAX_CONDITIONS_PER_RULE),
});

/** Strict condition (what the cloud may emit today). */
export const condSchema = z
  .object({
    f: z.enum(RULE_FIELDS),
    op: z.enum(RULE_OPS),
    v: z.union([value.min(1), z.array(value.min(1)).min(1).max(MAX_RULE_IN_VALUES)]),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message, path: ["v"] });
    if (c.op === "in" && !Array.isArray(c.v)) issue("`in` needs an array of values");
    if (c.op !== "in" && Array.isArray(c.v)) issue(`\`${c.op}\` needs a single value`);
    if (c.op === "re" && typeof c.v === "string" && !compiles(c.v)) issue("invalid regex");
    if (c.f === "device" && c.op !== "re") {
      const vs = Array.isArray(c.v) ? c.v : [c.v];
      if (c.op === "eq" || c.op === "in") {
        for (const d of vs)
          if (!(DEVICE_CLASSES as readonly string[]).includes(d))
            issue(`device must be one of ${DEVICE_CLASSES.join(", ")}`);
      }
    }
    if (c.f === "country" && (c.op === "eq" || c.op === "in")) {
      const vs = Array.isArray(c.v) ? c.v : [c.v];
      for (const x of vs) if (!/^[A-Z]{2}$/.test(x)) issue("country is an ISO-3166 alpha-2 code");
    }
  });
export type RuleCond = z.infer<typeof condSchema>;

/** Strict rule (writer side). Bundle-level checks (experiment, variant) live in the bundle schema. */
export const ruleSchema = z.object({
  id,
  exp: id,
  var: id,
  when: z.array(condSchema).min(1).max(MAX_CONDITIONS_PER_RULE),
});
export type Rule = z.infer<typeof ruleSchema>;

function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}
