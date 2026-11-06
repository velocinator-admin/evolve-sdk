// POST /api/evolve/aggregate (spec §9.2–9.5): the cloud asks, the app answers
// with sufficient statistics computed in its own DB, signed with the webhook secret.
import { createHash } from "node:crypto";
import {
  aggregateRequestSchema,
  createReplayGuard,
  DELIVERY_HEADER,
  isSupportedProtocol,
  parseSecretKey,
  type ReplayGuard,
  SIGNATURE_HEADER,
  signBody,
  unsupportedProtocolBody,
  verifyBody,
} from "@next-evolve/protocol";
import { runAggregate } from "../aggregate/run";
import type { ResolvedConfig } from "../config/config";
import type { Sql } from "../db/client";

type Env = Record<string, string | undefined>;

export type AggregateRouteDeps = {
  config: ResolvedConfig;
  env: Env;
  sql: () => Sql | null;
  sdkVersion: string;
  replay?: ReplayGuard;
  now?: () => number;
};

const MAX_BODY_BYTES = 256 * 1024;

const KEY = Symbol.for("next-evolve.replay");
/** Delivery ids seen in the last 10 minutes, shared by every signed cloud → app route. */
export function sharedReplayGuard(): ReplayGuard {
  const g = globalThis as { [KEY]?: ReplayGuard };
  g[KEY] ??= createReplayGuard();
  return g[KEY];
}

/**
 * True when a verified call is new: its delivery id and its signed message
 * (`t` + body) are both unseen. The delivery id isn't covered by the
 * signature, so checking it alone would let a captured call be replayed under
 * a fresh id within the signature window (T12.5).
 */
export function firstDelivery(
  guard: ReplayGuard,
  delivery: string | null,
  t: number,
  body: string,
): boolean {
  return !!delivery && guard.check(delivery) && firstMessage(guard, t, body);
}

/** True the first time this signed message (`t` + body) is seen in the replay window. */
export function firstMessage(guard: ReplayGuard, t: number, body: string): boolean {
  return guard.check(`msg:${t}:${createHash("sha256").update(body).digest("base64url")}`);
}

export type SignedCall = { body: string; signature: string | null; delivery: string | null };

/** An answer to a signed aggregate request: what the route returns, or the pull loop uploads. */
export type AggregateAnswer = { status: number; body: string; headers: Record<string, string> };

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

export async function handleAggregate(req: Request, deps: AggregateRouteDeps): Promise<Response> {
  const a = await answerAggregate(
    {
      body: await req.text(),
      signature: req.headers.get(SIGNATURE_HEADER),
      delivery: req.headers.get(DELIVERY_HEADER),
    },
    deps,
  );
  return new Response(a.body, { status: a.status, headers: a.headers });
}

/**
 * Verifies a signed aggregate request (signature, replay, pv, schema, site),
 * runs it, and signs the answer. Shared by the push route and pull mode, so
 * both answer exactly the same way.
 */
export async function answerAggregate(
  call: SignedCall,
  deps: AggregateRouteDeps,
): Promise<AggregateAnswer> {
  const secret = deps.env.EVOLVE_WEBHOOK_SECRET;
  const site = parseSecretKey(deps.env.EVOLVE_SECRET_KEY ?? "")?.siteId;
  if (!secret || !site) return answer(503, { error: "not_configured" });

  const { body } = call;
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return answer(413, { error: "too_large" });

  const now = deps.now ?? Date.now;
  const sig = verifyBody(call.signature, body, secret, {
    now: Math.floor(now() / 1000),
  });
  if (!sig.ok) return answer(401, { error: "invalid_signature", reason: sig.reason });
  const guard = deps.replay ?? sharedReplayGuard();
  if (!firstDelivery(guard, call.delivery, sig.t, body)) {
    return answer(409, { error: "replayed" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return answer(400, { error: "invalid_json" });
  }
  if (!isSupportedProtocol((parsed as { pv?: unknown } | null)?.pv)) {
    return answer(400, unsupportedProtocolBody());
  }
  const r = aggregateRequestSchema.safeParse(parsed);
  if (!r.success) return answer(400, { error: "invalid" });
  if (r.data.site !== site) return answer(403, { error: "site_mismatch" });

  const sql = deps.sql();
  if (!sql) return answer(503, { error: "no_database" });

  let result: Awaited<ReturnType<typeof runAggregate>>;
  try {
    result = await runAggregate(sql, r.data, {
      maxMs: deps.config.aggregate.maxMs,
      statementTimeoutMs: deps.config.aggregate.statementTimeoutMs,
      sdkVersion: deps.sdkVersion,
      now,
      ...(deps.config.retentionDays ? { retentionDays: deps.config.retentionDays } : {}),
    });
  } catch (e) {
    console.error("[evolve] aggregate failed", e);
    return answer(503, { error: "database_error" });
  }
  if (result.kind === "busy") {
    return answer(
      429,
      { busy: true, retryAfter: result.retryAfter },
      { "retry-after": String(result.retryAfter) },
    );
  }
  const out = JSON.stringify(result.response);
  return {
    status: 200,
    body: out,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      [SIGNATURE_HEADER]: signBody(secret, out, Math.floor(now() / 1000)),
    },
  };
}
