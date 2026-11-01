// Runs one aggregate request against the customer's DB (spec §9.3): idempotent
// per requestId, one at a time per database, inside a time budget. Shared by the
// aggregate route and `next-evolve aggregate`.
import { createHash } from "node:crypto";
import {
  type AggregateRequest,
  type AggregateResponse,
  type AggregateRow,
  MAX_RESPONSE_ROWS,
} from "@next-evolve/protocol";
import type { Sql } from "../db/client";
import { runAttribution } from "./attribution";

export type RunAggregateOptions = {
  /** Whole-request budget (spec: 25 s). */
  maxMs: number;
  /** Per-query cap (spec: 20 s). */
  statementTimeoutMs: number;
  sdkVersion: string;
  now?: () => number;
};

export type RunAggregateResult =
  | { kind: "ok"; response: AggregateResponse; cached: boolean }
  | { kind: "busy"; retryAfter: number };

/** Answer `429 { busy, retryAfter }` while another aggregate holds the lock. */
export const BUSY_RETRY_AFTER_SECONDS = 30;
/** Below this much budget left, don't start another query. */
const MIN_QUERY_MS = 500;
const QUERY_CANCELED = "57014";

/** Stored responses are replayed for this long (spec §9.3). */
const RUN_TTL = "24 hours";

async function storedResponse(sql: Sql, requestId: string): Promise<AggregateResponse | null> {
  const [hit] = await sql<{ response: AggregateResponse }[]>`
    select response from evolve.aggregate_runs
    where request_id = ${requestId} and status = 'done'
      and received_at > now() - ${RUN_TTL}::interval`;
  return hit?.response ?? null;
}

export async function runAggregate(
  sql: Sql,
  req: AggregateRequest,
  opts: RunAggregateOptions,
): Promise<RunAggregateResult> {
  const now = opts.now ?? Date.now;
  const started = now();

  const cached = await storedResponse(sql, req.requestId);
  if (cached) return { kind: "ok", response: cached, cached: true };

  // A session-level advisory lock needs one connection for the whole run.
  const conn = await sql.reserve();
  let locked = false;
  try {
    const [l] = await conn<{ ok: boolean }[]>`
      select pg_try_advisory_lock(hashtext('evolve.aggregate')) as ok`;
    locked = Boolean(l?.ok);
    if (!locked) return { kind: "busy", retryAfter: BUSY_RETRY_AFTER_SECONDS };

    // A retry that raced the first attempt: it finished while we waited.
    const raced = await storedResponse(conn, req.requestId);
    if (raced) return { kind: "ok", response: raced, cached: true };

    const deadline = started + opts.maxMs;
    const asOf = new Date(req.asOf);
    const rows: AggregateRow[] = [];
    const errors: AggregateResponse["errors"] = [];
    const remaining: string[] = [];

    for (const exp of req.experiments) {
      if (remaining.length) {
        remaining.push(exp.id);
        continue;
      }
      const expRows: AggregateRow[] = [];
      const expErrors: AggregateResponse["errors"] = [];
      let outOfBudget = false;
      for (const g of exp.goals) {
        const left = deadline - now();
        if (left < MIN_QUERY_MS) {
          outOfBudget = true;
          break;
        }
        const timeout = Math.floor(Math.min(opts.statementTimeoutMs, left));
        await conn.unsafe(`set statement_timeout = ${timeout}`);
        try {
          expRows.push(
            ...(await runAttribution(conn, {
              experimentId: exp.id,
              variants: exp.variants,
              goalKey: g.key,
              goal: g.def,
              asOf,
              cohortsFrom: exp.cohortsFrom,
            })),
          );
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === QUERY_CANCELED && now() >= deadline - MIN_QUERY_MS) {
            outOfBudget = true;
            break;
          }
          expErrors.push({
            exp: exp.id,
            goal: g.key,
            message: code === QUERY_CANCELED ? "statement timeout" : errorMessage(e),
          });
        }
      }
      // An experiment is returned whole or not at all, so the cloud never
      // replaces some of its goals with stale data and others with fresh.
      if (outOfBudget || rows.length + expRows.length > MAX_RESPONSE_ROWS) {
        remaining.push(exp.id);
        continue;
      }
      rows.push(...expRows);
      errors.push(...expErrors);
    }
    await conn.unsafe("set statement_timeout = 0");

    const usage = req.usageFrom
      ? (
          await conn<{ day: string; n: string }[]>`
            select to_char(day, 'YYYY-MM-DD') as day, tested_pageviews::text as n
            from evolve.usage_daily where day >= ${req.usageFrom}::date order by day`
        ).map((u) => ({ day: u.day, testedPageviews: Number(u.n) }))
      : [];

    const response: AggregateResponse = {
      pv: req.pv,
      requestId: req.requestId,
      site: req.site,
      asOf: req.asOf,
      sdk: opts.sdkVersion,
      mode: req.mode,
      durationMs: Math.max(0, Math.round(now() - started)),
      partial: remaining.length > 0,
      remaining,
      rows,
      usage,
      errors,
    };
    const body = JSON.stringify(response);
    await conn`
      insert into evolve.aggregate_runs
        (request_id, received_at, mode, status, duration_ms, response_hash, response)
      values (${req.requestId}, ${new Date(started)}, ${req.mode}, 'done', ${response.durationMs},
        ${createHash("sha256").update(body).digest("hex")}, (${body}::text)::jsonb)
      on conflict (request_id) do nothing`;
    await conn`delete from evolve.aggregate_runs where received_at < now() - ${RUN_TTL}::interval`;
    return { kind: "ok", response, cached: false };
  } finally {
    if (locked) {
      await conn.unsafe("set statement_timeout = 0").catch(() => {});
      await conn`select pg_advisory_unlock(hashtext('evolve.aggregate'))`.catch(() => {});
    }
    conn.release();
  }
}

function errorMessage(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 500);
}
