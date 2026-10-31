import { z } from "zod";

/** Attribution window: `<n>m`, `<n>h` or `<n>d` (e.g. `30m`, `7d`). Max 365 days. */
export const WINDOW_RE = /^([1-9]\d{0,3})([mhd])$/;
export const DEFAULT_WINDOW = "7d";
const UNIT_SECONDS = { m: 60, h: 3600, d: 86_400 } as const;
export const MAX_WINDOW_SECONDS = 365 * 86_400;

/** Window in seconds, or null if malformed or longer than 365 days. */
export function parseWindowSeconds(w: string): number | null {
  const m = WINDOW_RE.exec(w);
  if (!m) return null;
  const s = Number(m[1]) * UNIT_SECONDS[m[2] as keyof typeof UNIT_SECONDS];
  return s <= MAX_WINDOW_SECONDS ? s : null;
}

export const windowSchema = z
  .string()
  .refine((w) => parseWindowSeconds(w) !== null, "window must be <n>m|h|d, at most 365d");

/** Dotted prop path, e.g. `amount` or `order.total`. */
export const PROP_PATH_RE = /^[A-Za-z0-9_]{1,64}(\.[A-Za-z0-9_]{1,64}){0,7}$/;

/**
 * How a goal's value is read:
 * - null: conversion only (or the event's own `value` when present);
 * - prop: a numeric prop at `path`;
 * - local-fn: computed by a function in the customer's repo at write time and
 *   stored in `events.goal_values`; the function never leaves the app.
 */
export const goalValueSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("prop"), path: z.string().regex(PROP_PATH_RE) }),
    z.object({ kind: z.literal("local-fn") }),
  ])
  .nullable();

const common = {
  window: windowSchema,
  unit: z.enum(["visitor", "user"]),
  direction: z.enum(["increase", "decrease"]),
};

/** A goal definition as sent over the wire (manifest push, aggregate requests). */
export const serializedGoalSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("event"),
    event: z.string().min(1).max(100),
    source: z.string().min(1).max(64).nullable(),
    where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
    value: goalValueSchema,
    ...common,
  }),
  z.looseObject({
    kind: z.literal("pageview"),
    // Exact path, or a prefix with a trailing `*`.
    path: z
      .string()
      .regex(/^\/[^*\s]*\*?$/)
      .max(512),
    value: z.null(),
    ...common,
  }),
]);
export type SerializedGoal = z.infer<typeof serializedGoalSchema>;
