import { GOAL_KEY_RE, type SerializedGoal, serializedGoalSchema } from "@next-evolve/protocol";
import { logRateLimited } from "../core/log";

/** `<n>m`, `<n>h` or `<n>d`, at most 365 days. */
export type GoalWindow = `${number}${"m" | "h" | "d"}`;

type Common = {
  /** Attribution window after first exposure. Default `7d`. */
  window?: GoalWindow;
  /** Count per visitor (default) or per identified user. */
  unit?: "visitor" | "user";
  /** Whether higher is better. Default `increase`. */
  direction?: "increase" | "decrease";
};

/** An event as a goal's `value` function sees it (at write time, in your app). */
export type GoalEvent = {
  name: string;
  props: Record<string, unknown>;
  value: number | null;
  source: string;
  userId: string | null;
  anonId: string | null;
};

export type EventGoal = Common & {
  event: string;
  /** Only events from this source (e.g. `stripe`). */
  source?: string;
  /** Only events whose props equal these values. */
  where?: Record<string, string | number | boolean>;
  /** A numeric prop path (`"amount"`, `"order.total"`) or a function run locally at write time. */
  value?: string | ((e: GoalEvent) => number | null | undefined);
};

export type PageviewGoal = Common & {
  /** Exact path, or a prefix ending in `*` (e.g. `/docs/*`). */
  pageview: string;
};

export type GoalDefinition = EventGoal | PageviewGoal;
export type Goals = Record<string, GoalDefinition>;

/** Identity helper for `evolve.goals.ts`: types plus validation (throws on mistakes). */
export function defineGoals<const G extends Goals>(goals: G): G {
  serializeGoals(goals);
  return goals;
}

/**
 * Goal definitions as sent to the cloud. Function values become
 * `{ kind: "local-fn" }`; the function itself never leaves the app.
 */
export function serializeGoals(goals: Goals): Record<string, SerializedGoal> {
  const out: Record<string, SerializedGoal> = {};
  for (const [key, def] of Object.entries(goals)) {
    if (!GOAL_KEY_RE.test(key))
      throw new Error(`[evolve] goal key "${key}" must match ${GOAL_KEY_RE}`);
    if ("sql" in (def as object)) {
      throw new Error(`[evolve] goal "${key}": SQL goals aren't supported yet`);
    }
    const common = {
      window: def.window ?? "7d",
      unit: def.unit ?? "visitor",
      direction: def.direction ?? "increase",
    };
    let wire: unknown;
    if ("event" in def && "pageview" in def) {
      throw new Error(`[evolve] goal "${key}": use either event or pageview, not both`);
    } else if ("event" in def) {
      wire = {
        kind: "event",
        event: def.event,
        source: def.source ?? null,
        where: def.where ?? null,
        value:
          typeof def.value === "function"
            ? { kind: "local-fn" }
            : typeof def.value === "string"
              ? { kind: "prop", path: def.value }
              : null,
        ...common,
      };
    } else if ("pageview" in def) {
      wire = { kind: "pageview", path: def.pageview, value: null, ...common };
    } else {
      throw new Error(`[evolve] goal "${key}" needs event or pageview`);
    }
    const r = serializedGoalSchema.safeParse(wire);
    if (!r.success) {
      const what = r.error.issues.map((i) => `${i.path.join(".") || "goal"}: ${i.message}`);
      throw new Error(`[evolve] goal "${key}" is invalid (${what.join("; ")})`);
    }
    out[key] = r.data;
  }
  return out;
}

/** True if a stored `$pageview` at `path` would count for some pageview goal. */
export function matchesPageviewGoal(goals: Goals | undefined, path: string): boolean {
  if (!goals) return false;
  for (const def of Object.values(goals)) {
    if (!("pageview" in def)) continue;
    const p = def.pageview;
    if (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p) return true;
  }
  return false;
}

/**
 * Runs the `value` functions of matching event goals. Returns `{ goalKey: n }`
 * or null. A function that throws or returns a non-finite number is skipped.
 */
export function computeGoalValues(
  goals: Goals | undefined,
  e: GoalEvent,
): Record<string, number> | null {
  if (!goals) return null;
  let out: Record<string, number> | null = null;
  for (const [key, def] of Object.entries(goals)) {
    if (!("event" in def) || typeof def.value !== "function" || def.event !== e.name) continue;
    if (def.source !== undefined && def.source !== e.source) continue;
    if (def.where && !Object.entries(def.where).every(([k, v]) => e.props[k] === v)) continue;
    try {
      const v = def.value(e);
      if (typeof v === "number" && Number.isFinite(v)) {
        out ??= {};
        out[key] = v;
      }
    } catch (err) {
      logRateLimited(`goal:${key}`, `goal "${key}": value function threw`, err);
    }
  }
  return out;
}
