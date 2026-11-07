import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { ID_RE, REGION_ID_RE, SITE_ID_RE } from "./ids";
import { MAX_RULES_PER_BUNDLE, MAX_RULES_PER_EXPERIMENT, ruleReaderSchema } from "./rules";

/** Max experiments that can apply to one route (a variant code holds ≤ 3 pairs). */
export const MAX_EXPERIMENTS_PER_ROUTE = 3;
/** Bundles expire 14 days after signing unless re-signed. */
export const BUNDLE_TTL_SECONDS = 14 * 86_400;

const id = z.string().regex(ID_RE);

// Readers use loose objects so fields added later within the same `pv` are
// kept and ignored, never rejected (spec §7.10).
const experimentSchema = z.looseObject({
  status: z.enum(["running", "completed"]),
  traffic: z.number().min(0).max(1),
  control: id,
  winner: id.optional(),
  variants: z
    .array(z.looseObject({ id, w: z.number().min(0).finite() }))
    .min(1)
    .max(6),
});

const variantSchema = z.looseObject({
  exp: id,
  region: z.string().regex(REGION_ID_RE),
  ctrl: z.boolean(),
  props: z.record(z.string(), z.unknown()),
});

export const bundlePayloadSchema = z
  .looseObject({
    pv: z.number().int().positive(),
    site: z.string().regex(SITE_ID_RE),
    ver: z.number().int().nonnegative(),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    hash: z.string(),
    routing: z.looseObject({
      routes: z.record(
        z.string().startsWith("/"),
        z.array(z.string()).max(MAX_EXPERIMENTS_PER_ROUTE),
      ),
      experiments: z.record(id, experimentSchema),
    }),
    variants: z.record(id, variantSchema),
    /** UTM rules (1.3.0, D75), in dashboard order. Absent = no rules. */
    rules: z.array(ruleReaderSchema).max(MAX_RULES_PER_BUNDLE).optional(),
  })
  .superRefine((b, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });

    if (b.exp <= b.iat) issue("exp must be after iat", ["exp"]);

    for (const [route, exps] of Object.entries(b.routing.routes)) {
      exps.forEach((e, i) => {
        if (!b.routing.experiments[e])
          issue(`unknown experiment ${e}`, ["routing", "routes", route, i]);
      });
    }

    for (const [expId, e] of Object.entries(b.routing.experiments)) {
      const path = ["routing", "experiments", expId];
      const ids = new Set(e.variants.map((v) => v.id));
      if (ids.size !== e.variants.length) issue("duplicate variant ids", [...path, "variants"]);
      if (!ids.has(e.control)) issue("control must be one of the variants", [...path, "control"]);
      if (e.status === "running" && !e.variants.some((v) => v.w > 0)) {
        issue("at least one weight must be > 0", [...path, "variants"]);
      }
      if (e.status === "completed") {
        if (!e.winner) issue("completed experiment needs a winner", [...path, "winner"]);
        else if (!ids.has(e.winner))
          issue("winner must be one of the variants", [...path, "winner"]);
      }
      for (const v of e.variants) {
        const def = b.variants[v.id];
        if (!def) issue(`variant ${v.id} missing from variants`, ["variants", v.id]);
        else if (def.exp !== expId)
          issue(`variant ${v.id} belongs to ${def.exp}`, ["variants", v.id, "exp"]);
      }
    }

    const ruleIds = new Set<string>();
    const perExp = new Map<string, number>();
    b.rules?.forEach((r, i) => {
      const path = ["rules", i];
      if (ruleIds.has(r.id)) issue(`duplicate rule id ${r.id}`, [...path, "id"]);
      ruleIds.add(r.id);
      const n = (perExp.get(r.exp) ?? 0) + 1;
      perExp.set(r.exp, n);
      if (n === MAX_RULES_PER_EXPERIMENT + 1)
        issue(`more than ${MAX_RULES_PER_EXPERIMENT} rules for ${r.exp}`, path);
      const e = b.routing.experiments[r.exp];
      if (!e) issue(`unknown experiment ${r.exp}`, [...path, "exp"]);
      else if (e.status !== "running") issue(`experiment ${r.exp} isn't running`, [...path, "exp"]);
      else if (!e.variants.some((v) => v.id === r.var) || b.variants[r.var]?.exp !== r.exp)
        issue(`variant ${r.var} isn't a variant of ${r.exp}`, [...path, "var"]);
    });
  });

export type BundlePayload = z.infer<typeof bundlePayloadSchema>;
export type BundleExperiment = BundlePayload["routing"]["experiments"][string];
export type BundleVariant = BundlePayload["variants"][string];

export function parseBundlePayload(input: unknown) {
  return bundlePayloadSchema.safeParse(input);
}

export type BundleRule = NonNullable<BundlePayload["rules"]>[number];

/**
 * sha256 of the canonical serving content (routing + variants): the signed
 * `hash` field every reader verifies. Ignores ver/iat/exp. It does not cover
 * `rules`: readers before 1.3.0 recompute it from routing + variants only, so
 * including rules would make them reject the bundle. The JWS signature covers
 * the rules; {@link computeContentHash} tells whether content changed.
 */
export function computeBundleHash(b: Pick<BundlePayload, "routing" | "variants">): string {
  return sha256Hex(canonicalJson({ routing: b.routing, variants: b.variants }));
}

/**
 * Change detection for publishers (D75): equals {@link computeBundleHash} for a
 * bundle without `rules`, and also covers `rules` when the field is present.
 */
export function computeContentHash(
  b: Pick<BundlePayload, "routing" | "variants"> & { rules?: unknown },
): string {
  if (b.rules === undefined) return computeBundleHash(b);
  return sha256Hex(canonicalJson({ routing: b.routing, variants: b.variants, rules: b.rules }));
}
