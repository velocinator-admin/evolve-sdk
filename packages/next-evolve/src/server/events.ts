import { computeGoalValues, type Goals } from "../config/goals";
import type { EventRow } from "../db/writer";

/** Props larger than this (as JSON) are dropped from the event. */
export const MAX_PROPS_BYTES = 2048;

export type TrackInput = {
  userId?: string | null;
  anonId?: string | null;
  value?: number | null;
  props?: Record<string, unknown> | null;
  source?: string;
  ts?: Date | string | number;
  dedupeKey?: string | null;
  path?: string | null;
};

const clean = (s: unknown, max: number): string | null =>
  typeof s === "string" && s.length > 0 ? s.slice(0, max) : null;

function capProps(p: unknown): Record<string, unknown> | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  try {
    return JSON.stringify(p).length <= MAX_PROPS_BYTES ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toDate(ts: TrackInput["ts"], now: Date): Date {
  if (ts === undefined) return now;
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? now : d;
}

/** Normalizes one event and runs goal `value` functions (locally, at write time). */
export function eventRow(
  name: string,
  input: TrackInput,
  goals: Goals | undefined,
  defaultSource: string,
  now = new Date(),
): EventRow | null {
  const n = clean(name, 100);
  if (!n) return null;
  const props = capProps(input.props);
  const value =
    typeof input.value === "number" && Number.isFinite(input.value) ? input.value : null;
  const source = clean(input.source, 64) ?? defaultSource;
  const userId = clean(input.userId, 256);
  const anonId = clean(input.anonId, 64);
  return {
    ts: toDate(input.ts, now),
    name: n,
    anon_id: anonId,
    user_id: userId,
    value,
    goal_values: computeGoalValues(goals, {
      name: n,
      props: props ?? {},
      value,
      source,
      userId,
      anonId,
    }),
    props,
    source,
    path: clean(input.path, 512),
    dedupe_key: clean(input.dedupeKey, 200),
  };
}

/** `YYYY-MM-DD` in UTC. */
export const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);
