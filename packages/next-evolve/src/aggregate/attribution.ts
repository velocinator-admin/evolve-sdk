// Local attribution SQL (spec §9.4): turns exposures + events in the customer's
// Postgres into sufficient statistics per variant × segment × cohort day.
// Runs only on the customer's side; nothing here leaves the app but the counts.
import { type AggregateRow, parseWindowSeconds, type SerializedGoal } from "@next-evolve/protocol";
import type { Sql } from "../db/client";

export type AttributionInput = {
  experimentId: string;
  /** Only exposures to these variants count. */
  variants: readonly string[];
  goalKey: string;
  goal: SerializedGoal;
  /** Upper bound for exposures and events (exclusive). */
  asOf: Date;
  /** Only units whose cohort day (UTC day of first exposure) is on/after this `YYYY-MM-DD`. */
  cohortsFrom: string;
};

type Fragment = ReturnType<Sql>;

// A text value counts as a number only if it looks like one and can't overflow
// float8, so one malformed prop never fails the whole query.
const NUMERIC_RE = "^\\s*-?(\\d{1,30}(\\.\\d{0,30})?|\\.\\d{1,30})([eE][-+]?\\d{1,2})?\\s*$";

function numericText(sql: Sql, text: Fragment): Fragment {
  return sql`(case when ${text} ~ ${NUMERIC_RE} then (${text})::float8 end)`;
}

/** The event's value for this goal (null → conversion only). */
function valueExpr(sql: Sql, key: string, goal: SerializedGoal): Fragment {
  if (goal.kind === "pageview" || goal.value === null) return sql`e.value`;
  if (goal.value.kind === "local-fn") return numericText(sql, sql`e.goal_values ->> ${key}::text`);
  // Paths and ids are validated by regex (no commas, no dots inside segments),
  // so string_to_array is safe and avoids array parameters, which postgres.js
  // can't type without prepared statements.
  return numericText(sql, sql`e.props #>> string_to_array(${goal.value.path}::text, '.')`);
}

/** Which events count for this goal (window and unit join come from the caller). */
function matchExpr(sql: Sql, goal: SerializedGoal): Fragment {
  if (goal.kind === "pageview") {
    const pathMatch = goal.path.endsWith("*")
      ? sql`starts_with(e.path, ${goal.path.slice(0, -1)}::text)`
      : sql`e.path = ${goal.path}::text`;
    return sql`e.name = '$pageview' and ${pathMatch}`;
  }
  const source = goal.source === null ? sql`` : sql`and e.source = ${goal.source}::text`;
  const where =
    goal.where === null ? sql`` : sql`and e.props @> (${JSON.stringify(goal.where)}::text)::jsonb`;
  return sql`e.name = ${goal.event}::text ${source} ${where}`;
}

type RawRow = {
  variant_id: string;
  seg: string;
  day: string;
  n: number;
  c: number;
  s1: number;
  s2: number;
  mn: number;
  mc: number;
  ms1: number;
  ms2: number;
};

/**
 * The attribution query for one experiment × goal. An event counts for a unit
 * when it falls in `[first exposure, first exposure + window)`, capped at
 * `asOf`. A unit is mature when its whole window ended before `asOf`.
 *
 * - visitor unit: one unit per exposed anon id; events match on the anon id,
 *   or on the linked user id (cross-device and server events).
 * - user unit: identified exposures only, one unit per user at their earliest
 *   exposure; events match on the user id or any of the user's anon ids.
 */
export function attributionQuery(sql: Sql, input: AttributionInput) {
  const windowSeconds = parseWindowSeconds(input.goal.window);
  if (windowSeconds === null) throw new Error(`invalid goal window ${input.goal.window}`);
  const asOf = input.asOf.toISOString();
  const from = `${input.cohortsFrom}T00:00:00Z`;
  const win = sql`make_interval(secs => ${windowSeconds}::int)`;
  const asOfTs = sql`${asOf}::timestamptz`;
  const val = valueExpr(sql, input.goalKey, input.goal);
  const match = matchExpr(sql, input.goal);
  const inWindow = sql`e.ts >= u.first_at and e.ts < least(u.first_at + ${win}, ${asOfTs})`;
  const variants = sql`string_to_array(${input.variants.join(",")}::text, ',')`;

  const units =
    input.goal.unit === "visitor"
      ? sql`
    u as (
      select x.anon_id as unit, x.variant_id, x.first_at, coalesce(x.segment, 'main') as seg,
             i.user_id, (x.first_at + ${win} <= ${asOfTs}) as mature
      from evolve.exposures x
      left join evolve.identities i on i.anon_id = x.anon_id
      where x.experiment_id = ${input.experimentId}::text
        and x.variant_id = any(${variants})
        and x.first_at >= ${from}::timestamptz and x.first_at < ${asOfTs}),
    hits as (
      select u.unit, ${val} as v from u
      join evolve.events e on e.anon_id = u.unit
      where ${match} and ${inWindow}
      union all
      select u.unit, ${val} from u
      join evolve.events e on e.user_id = u.user_id
      where u.user_id is not null and (e.anon_id is null or e.anon_id <> u.unit)
        and ${match} and ${inWindow})`
      : sql`
    firsts as (
      -- Earliest exposure per user over all cohorts, so a user exposed again on
      -- another device never becomes a second unit in a later cohort.
      select distinct on (i.user_id) i.user_id as unit, x.variant_id, x.first_at,
             coalesce(x.segment, 'main') as seg
      from evolve.exposures x
      join evolve.identities i on i.anon_id = x.anon_id
      where x.experiment_id = ${input.experimentId}::text and x.first_at < ${asOfTs}
      order by i.user_id, x.first_at, x.anon_id),
    u as (
      select unit, variant_id, first_at, seg, (first_at + ${win} <= ${asOfTs}) as mature
      from firsts
      where variant_id = any(${variants}) and first_at >= ${from}::timestamptz),
    hits as (
      select u.unit, ${val} as v from u
      join evolve.events e on e.user_id = u.unit
      where ${match} and ${inWindow}
      union all
      select u.unit, ${val} from u
      join evolve.identities ia on ia.user_id = u.unit
      join evolve.events e on e.anon_id = ia.anon_id
      where (e.user_id is null or e.user_id <> u.unit) and ${match} and ${inWindow})`;

  return sql<RawRow[]>`
    with ${units},
    per_unit as (select unit, sum(coalesce(v, 0)) as v from hits group by unit)
    select u.variant_id, u.seg,
      to_char((u.first_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
      count(*)::int as n,
      count(p.unit)::int as c,
      coalesce(sum(p.v), 0)::float8 as s1,
      coalesce(sum(p.v * p.v), 0)::float8 as s2,
      (count(*) filter (where u.mature))::int as mn,
      (count(p.unit) filter (where u.mature))::int as mc,
      coalesce(sum(p.v) filter (where u.mature), 0)::float8 as ms1,
      coalesce(sum(p.v * p.v) filter (where u.mature), 0)::float8 as ms2
    from u left join per_unit p on p.unit = u.unit
    group by 1, 2, 3
    order by 3, 1, 2`;
}

/** Runs the attribution query and returns protocol rows. */
export async function runAttribution(sql: Sql, input: AttributionInput): Promise<AggregateRow[]> {
  const rows = await attributionQuery(sql, input);
  return rows.map((r) => ({
    exp: input.experimentId,
    var: r.variant_id,
    goal: input.goalKey,
    seg: r.seg,
    day: r.day,
    n: r.n,
    c: r.c,
    s1: r.s1,
    s2: r.s2,
    mn: r.mn,
    mc: r.mc,
    ms1: r.ms1,
    ms2: r.ms2,
  }));
}
