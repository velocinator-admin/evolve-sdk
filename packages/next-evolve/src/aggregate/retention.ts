// Local retention (OPS-1, `retentionDays`): a daily cleanup that runs inside
// aggregate requests (push or pull), so the app needs no cron of its own.
// Deletes in small batches so it never holds long locks on `evolve.events`,
// and never deletes what a running or paused experiment's aggregation reads.
import type { Sql } from "../db/client";

const DAY_MS = 86_400_000;
/** An experiment the cloud asked about within this many days of the latest ask is active. */
export const ACTIVE_WINDOW_DAYS = 7;
/**
 * Tracking must have run this long before the first delete: the cloud asks
 * about every running and paused experiment at least once a day (daily full).
 */
export const WARMUP_HOURS = 26;
/** Rows per delete statement. */
export const CLEANUP_BATCH = 5_000;
/** Most time one aggregate request spends on cleanup. */
export const MAX_CLEANUP_MS = 10_000;
const MAX_STATEMENT_MS = 5_000;
const UNDEFINED_TABLE = "42P01";
const QUERY_CANCELED = "57014";

export type Deleted = { events: number; exposures: number; vitals: number };

export type CleanupResult =
  | { status: "skipped"; reason: "not_migrated" | "warming_up" | "done_today" | "no_time" }
  | { status: "partial" | "done"; deleted: Deleted; cutoff: string };

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isCode = (e: unknown, code: string) => (e as { code?: string } | null)?.code === code;

/** Marks the request's experiments as still aggregated by the cloud. */
async function recordActivity(sql: Sql, ids: readonly string[], at: Date): Promise<void> {
  if (!ids.length) return;
  await sql`
    insert into evolve.experiment_activity (experiment_id, first_seen_at, last_seen_at)
    select id, ${at}, ${at} from unnest(${[...ids]}::text[]) as id
    on conflict (experiment_id) do update set last_seen_at = greatest(
      evolve.experiment_activity.last_seen_at, excluded.last_seen_at)`;
}

/**
 * The retention step of an aggregate request: record activity, then (once per
 * UTC day, resumed by later requests until done) delete old rows within
 * `budgetMs`. Never throws: a cleanup problem never fails an aggregate.
 */
export async function retentionStep(
  sql: Sql,
  o: { experimentIds: readonly string[]; retentionDays: number; budgetMs: number; now: number },
): Promise<CleanupResult> {
  try {
    await recordActivity(sql, o.experimentIds, new Date(o.now));
    return await dailyCleanup(sql, o);
  } catch (e) {
    if (isCode(e, UNDEFINED_TABLE)) {
      warnOnce(
        "[evolve] retentionDays is set but the database isn't migrated: run `npx next-evolve migrate`",
      );
      return { status: "skipped", reason: "not_migrated" };
    }
    console.error("[evolve] cleanup failed", e);
    return { status: "skipped", reason: "no_time" };
  } finally {
    await sql.unsafe("set statement_timeout = 0").catch(() => {});
  }
}

let warned = false;
function warnOnce(msg: string) {
  if (warned) return;
  warned = true;
  console.warn(msg);
}

export async function dailyCleanup(
  sql: Sql,
  o: { retentionDays: number; budgetMs: number; now: number },
): Promise<CleanupResult> {
  // Wall clock for the budget; `o.now` only dates the run (tests move it).
  const deadline = Date.now() + Math.min(o.budgetMs, MAX_CLEANUP_MS);
  const left = () => deadline - Date.now();
  if (left() < 500) return { status: "skipped", reason: "no_time" };

  const today = utcDay(o.now);
  await sql`insert into evolve.cleanup_runs (day, started_at) values (${today}::date, ${new Date(o.now)})
    on conflict (day) do nothing`;
  const [run] = await sql<{ finished: boolean }[]>`
    select finished_at is not null as finished from evolve.cleanup_runs where day = ${today}::date`;
  if (run?.finished) return { status: "skipped", reason: "done_today" };

  const [w] = await sql<{ since: Date | null }[]>`
    select min(first_seen_at) as since from evolve.experiment_activity`;
  if (!w?.since || new Date(w.since).getTime() > o.now - WARMUP_HOURS * 3_600_000) {
    return { status: "skipped", reason: "warming_up" };
  }

  // Active: asked about within 7 days of the latest ask (not of now, so a long
  // cloud outage never makes every experiment look stopped).
  const active = (
    await sql<{ id: string }[]>`
      select experiment_id as id from evolve.experiment_activity
      where last_seen_at >= (select max(last_seen_at) from evolve.experiment_activity)
        - make_interval(days => ${ACTIVE_WINDOW_DAYS})`
  ).map((r) => r.id);
  // Attribution reads events from a unit's first exposure on, and exposures
  // only exist after an experiment starts: keep everything from the earliest
  // exposure of any active experiment (one index probe each), a day early.
  const [f] = await sql<{ at: Date | null }[]>`
    select min(x.first_at) as at from unnest(${active}::text[]) as a(id)
    cross join lateral (
      select first_at from evolve.exposures where experiment_id = a.id
      order by first_at limit 1) x`;
  const base = Date.parse(`${utcDay(o.now - o.retentionDays * DAY_MS)}T00:00:00Z`);
  const floor = f?.at ? Date.parse(`${utcDay(new Date(f.at).getTime() - DAY_MS)}T00:00:00Z`) : null;
  const cutoff = new Date(floor === null ? base : Math.min(base, floor));
  const baseAt = new Date(base);

  const deleted: Deleted = { events: 0, exposures: 0, vitals: 0 };
  const batch = async (q: () => Promise<{ n: number; more: boolean }>, k: keyof Deleted) => {
    for (;;) {
      const ms = left();
      if (ms < 500) return false;
      await sql.unsafe(`set statement_timeout = ${Math.floor(Math.min(MAX_STATEMENT_MS, ms))}`);
      let r: { n: number; more: boolean };
      try {
        r = await q();
      } catch (e) {
        if (isCode(e, QUERY_CANCELED)) return false;
        throw e;
      }
      deleted[k] += r.n;
      if (!r.more) return true;
    }
  };

  // Events: walk the primary key from the oldest id. Ids grow with
  // received_at, so the walk stops at the first batch that reaches the cutoff.
  // A row goes only when both its time and its arrival are before the cutoff.
  let cursor = 0;
  const events = await batch(async () => {
    const [r] = await sql<{ last: string | null; recent: boolean; n: number }[]>`
      with b as (
        select id, ts, received_at from evolve.events where id > ${cursor}
        order by id limit ${CLEANUP_BATCH}),
      d as (
        delete from evolve.events e using b
        where e.id = b.id and b.ts < ${cutoff} and b.received_at < ${cutoff}
        returning 1)
      select (select max(id) from b)::text as last,
        coalesce((select bool_or(received_at >= ${cutoff}) from b), false) as recent,
        (select count(*) from d)::int as n`;
    if (!r?.last) return { n: r?.n ?? 0, more: false };
    cursor = Number(r.last);
    return { n: r.n, more: !r.recent };
  }, "events");

  // Exposures of experiments the cloud no longer aggregates.
  const exposures =
    events &&
    (await batch(async () => {
      const [r] = await sql<{ n: number }[]>`
        with d as (
          delete from evolve.exposures where (experiment_id, anon_id) in (
            select experiment_id, anon_id from evolve.exposures
            where first_at < ${baseAt} and experiment_id <> all(${active}::text[])
            limit ${CLEANUP_BATCH})
          returning 1)
        select count(*)::int as n from d`;
      return { n: r?.n ?? 0, more: (r?.n ?? 0) === CLEANUP_BATCH };
    }, "exposures"));

  // Vitals histograms (the cloud only re-reads the last 7 days).
  const vitals =
    exposures &&
    (await batch(async () => {
      const [r] = await sql<{ n: number }[]>`
        with d as (
          delete from evolve.vitals_daily where ctid = any(array(
            select ctid from evolve.vitals_daily where day < ${utcDay(cutoff.getTime())}::date
            limit ${CLEANUP_BATCH}))
          returning 1)
        select count(*)::int as n from d`;
      return { n: r?.n ?? 0, more: (r?.n ?? 0) === CLEANUP_BATCH };
    }, "vitals"));
  const finished = Boolean(vitals);

  await sql.unsafe("set statement_timeout = 0");
  await sql`
    update evolve.cleanup_runs set
      finished_at = ${finished ? new Date() : null},
      deleted = jsonb_build_object(
        'events', coalesce((deleted ->> 'events')::bigint, 0) + ${deleted.events},
        'exposures', coalesce((deleted ->> 'exposures')::bigint, 0) + ${deleted.exposures},
        'vitals', coalesce((deleted ->> 'vitals')::bigint, 0) + ${deleted.vitals})
    where day = ${today}::date`;
  await sql`delete from evolve.cleanup_runs where day < ${today}::date - 90`;
  return { status: finished ? "done" : "partial", deleted, cutoff: cutoff.toISOString() };
}
