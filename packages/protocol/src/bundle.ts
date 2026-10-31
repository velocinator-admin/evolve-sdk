import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { ID_RE, REGION_ID_RE, SITE_ID_RE } from "./ids";

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
  });

export type BundlePayload = z.infer<typeof bundlePayloadSchema>;
export type BundleExperiment = BundlePayload["routing"]["experiments"][string];
export type BundleVariant = BundlePayload["variants"][string];

export function parseBundlePayload(input: unknown) {
  return bundlePayloadSchema.safeParse(input);
}

/** sha256 of the canonical serving content (routing + variants). Ignores ver/iat/exp. */
export function computeBundleHash(b: Pick<BundlePayload, "routing" | "variants">): string {
  return sha256Hex(canonicalJson({ routing: b.routing, variants: b.variants }));
}
