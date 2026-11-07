import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { serializedGoalSchema } from "./goals";
import { GOAL_KEY_RE, REGION_ID_RE } from "./ids";
import { MAX_REGION_VARS, VAR_NAME_RE } from "./template";

/** Size caps the cloud enforces on region registrations (bytes of canonical JSON). */
export const MAX_REGION_SCHEMA_BYTES = 64 * 1024;
export const MAX_REGION_CONTROL_BYTES = 16 * 1024;
export const MAX_MANIFEST_ROUTES = 200;
export const MAX_MANIFEST_GOALS = 200;

const path = z.string().startsWith("/").max(512);

/**
 * `POST /v1/manifest` (spec §8.4): the app's configuration, pushed at startup
 * and by `evolve push`. Configuration only; never visitor data.
 */
export const manifestSchema = z.looseObject({
  pv: z.number().int().positive(),
  sdkVersion: z.string().min(1).max(64),
  protocol: z.looseObject({ supported: z.array(z.number().int().positive()).min(1).max(16) }),
  nextVersion: z.string().max(64).nullable(),
  routes: z
    .record(path, z.looseObject({ mode: z.enum(["static", "dynamic"]) }))
    .refine((r) => Object.keys(r).length <= MAX_MANIFEST_ROUTES, "too many routes"),
  goals: z
    .record(z.string().regex(GOAL_KEY_RE), serializedGoalSchema)
    .refine((g) => Object.keys(g).length <= MAX_MANIFEST_GOALS, "too many goals"),
  /** {@link computeManifestHash} of routes + goals. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The app's public base URL (sync + aggregate routes), when known. */
  appUrl: z
    .url({ protocol: /^https?$/ })
    .max(512)
    .nullable(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export function computeManifestHash(m: Pick<Manifest, "routes" | "goals">): string {
  return sha256Hex(canonicalJson({ routes: m.routes, goals: m.goals }));
}

const bytes = (v: unknown) => Buffer.byteLength(canonicalJson(v));

/** `POST /v1/regions` (spec §5.2): one `<Optimizable>` region as rendered on `path`. */
export const regionRegistrationSchema = z.looseObject({
  pv: z.number().int().positive(),
  id: z.string().regex(REGION_ID_RE),
  jsonSchema: z
    .record(z.string(), z.unknown())
    .refine((s) => bytes(s) <= MAX_REGION_SCHEMA_BYTES, "jsonSchema too large"),
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Control props, schema keys only. */
  controlProps: z
    .record(z.string(), z.unknown())
    .refine((p) => bytes(p) <= MAX_REGION_CONTROL_BYTES, "controlProps too large"),
  path,
  /**
   * Protocol 1.4.0 (TPL-1.2): names of the `{var}` placeholders this region can
   * fill on `path` (route params and `<Optimizable vars>` keys). Names only,
   * never values. Absent = none (SDKs before 0.9).
   */
  vars: z.array(z.string().regex(VAR_NAME_RE)).max(MAX_REGION_VARS).optional(),
});
export type RegionRegistration = z.infer<typeof regionRegistrationSchema>;
