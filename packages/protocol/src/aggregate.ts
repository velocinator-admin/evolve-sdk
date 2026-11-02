import { z } from "zod";
import { serializedGoalSchema } from "./goals";
import { GOAL_KEY_RE, ID_RE, REQUEST_ID_RE, SITE_ID_RE } from "./ids";
import { MAX_VITALS_ROWS, vitalsRequestSchema, vitalsRowSchema } from "./vitals";

export const MAX_EXPERIMENTS_PER_REQUEST = 5;
export const MAX_GOALS_PER_EXPERIMENT = 20;
export const MAX_RESPONSE_ROWS = 20_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const id = z.string().regex(ID_RE);
const isoDay = z.iso.date();
const isoTime = z.iso.datetime();
const count = z.number().int().nonnegative();

/** `POST <appUrl>/api/evolve/aggregate` body (spec §9.2). */
export const aggregateRequestSchema = z.looseObject({
  type: z.literal("aggregate.request"),
  pv: z.number().int().positive(),
  requestId: z.string().regex(REQUEST_ID_RE),
  site: z.string().regex(SITE_ID_RE),
  asOf: isoTime,
  mode: z.enum(["incremental", "full"]),
  experiments: z
    .array(
      z.looseObject({
        id,
        variants: z.array(id).min(1).max(6),
        cohortsFrom: isoDay,
        goals: z
          .array(
            z.looseObject({
              key: z.string().regex(GOAL_KEY_RE),
              role: z.enum(["primary", "secondary"]),
              hash: z.string().min(1).max(128),
              def: serializedGoalSchema,
            }),
          )
          .min(1)
          .max(MAX_GOALS_PER_EXPERIMENT),
      }),
    )
    .max(MAX_EXPERIMENTS_PER_REQUEST),
  usageFrom: isoDay.nullable(),
  /** Protocol 1.1.0: absent = don't send vitals (spec §9.3). SDKs before 0.5 ignore it. */
  vitals: vitalsRequestSchema.optional(),
});
export type AggregateRequest = z.infer<typeof aggregateRequestSchema>;

/**
 * Sufficient statistics for one experiment × variant × goal × segment × cohort
 * day. Additive across days. Contains no visitor or user ids.
 */
export const aggregateRowSchema = z
  .looseObject({
    exp: id,
    var: id,
    goal: z.string().regex(GOAL_KEY_RE),
    seg: z.string().min(1).max(64),
    day: isoDay,
    n: count,
    c: count,
    s1: z.number().finite(),
    s2: z.number().finite().nonnegative(),
    mn: count,
    mc: count,
    ms1: z.number().finite(),
    ms2: z.number().finite().nonnegative(),
  })
  .refine((r) => r.c <= r.n && r.mn <= r.n && r.mc <= r.mn && r.mc <= r.c, {
    message: "counts must satisfy c ≤ n, mn ≤ n, mc ≤ mn, mc ≤ c",
  });
export type AggregateRow = z.infer<typeof aggregateRowSchema>;

/** Signed response from the app's aggregate route (spec §9.5). */
export const aggregateResponseSchema = z.looseObject({
  pv: z.number().int().positive(),
  requestId: z.string().regex(REQUEST_ID_RE),
  site: z.string().regex(SITE_ID_RE),
  asOf: isoTime,
  sdk: z.string().min(1).max(64),
  mode: z.enum(["incremental", "full"]),
  durationMs: count,
  partial: z.boolean(),
  remaining: z.array(id),
  rows: z.array(aggregateRowSchema).max(MAX_RESPONSE_ROWS),
  usage: z.array(z.looseObject({ day: isoDay, testedPageviews: count })),
  errors: z.array(
    z.looseObject({
      exp: id.optional(),
      goal: z.string().optional(),
      message: z.string().max(1000),
    }),
  ),
  /** Protocol 1.1.0: only when the request asked for `vitals` and the query succeeded. */
  vitals: z.array(vitalsRowSchema).max(MAX_VITALS_ROWS).optional(),
});
export type AggregateResponse = z.infer<typeof aggregateResponseSchema>;

/** Answer when the aggregate lock is held by another request. */
export type AggregateBusy = { busy: true; retryAfter: number };
