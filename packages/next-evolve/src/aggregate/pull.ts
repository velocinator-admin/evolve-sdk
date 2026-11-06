// Pull mode (AGG-2): for servers the cloud can't reach. Every 60 s the app
// polls `GET /v1/aggregate-requests` with its secret key, answers each signed
// request with the same code as the push route, and posts the signed answer
// to `POST /v1/aggregates`. Long-running Node only (`next start`, Docker).
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  AGGREGATE_PULL_PATH,
  AGGREGATE_UPLOAD_PATH,
  aggregatePullSchema,
  isSupportedProtocol,
  PULL_INTERVAL_SECONDS,
} from "@next-evolve/protocol";
import { type AggregateRouteDeps, answerAggregate } from "../server/aggregate-route";

type MiniFetch = (
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
) => Promise<{ status: number; text: string }>;

export type PullDeps = AggregateRouteDeps & {
  cloudUrl: string;
  /** Inject an HTTP client (tests). Default: node:http(s), never Next's patched fetch. */
  fetch?: MiniFetch;
  log?: (msg: string) => void;
};

export type PullResult = {
  /** Requests the cloud handed out. */
  pulled: number;
  /** Answers the cloud accepted. */
  uploaded: number;
  /** Requests not answered (bad signature, busy, DB error) or answers refused. */
  failed: number;
  error?: string;
};

const POLL_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 30_000;

/** One poll: fetch pending requests, answer each in order, upload the answers. */
export async function pullOnce(deps: PullDeps): Promise<PullResult> {
  const key = deps.env.EVOLVE_SECRET_KEY;
  const out: PullResult = { pulled: 0, uploaded: 0, failed: 0 };
  if (!key) return { ...out, error: "no_key" };
  const send = deps.fetch ?? nodeFetch;
  const auth = { authorization: `Bearer ${key}` };

  let parsed: ReturnType<typeof aggregatePullSchema.safeParse>;
  try {
    const res = await send(new URL(AGGREGATE_PULL_PATH, deps.cloudUrl), {
      method: "GET",
      headers: auth,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    if (res.status !== 200) return { ...out, error: `poll HTTP ${res.status}` };
    const json = JSON.parse(res.text) as { pv?: unknown };
    if (!isSupportedProtocol(json?.pv)) return { ...out, error: "unsupported protocol" };
    parsed = aggregatePullSchema.safeParse(json);
  } catch (e) {
    return { ...out, error: `poll failed: ${e instanceof Error ? e.message : e}` };
  }
  if (!parsed.success) return { ...out, error: "invalid poll response" };

  for (const item of parsed.data.requests) {
    out.pulled++;
    // Same checks and runner as a pushed request (signature, replay, site, lock, budget).
    const a = await answerAggregate(item, deps);
    if (a.status !== 200) {
      out.failed++;
      deps.log?.(
        `[evolve] pulled aggregate request not answered (${a.status} ${a.body.slice(0, 200)})`,
      );
      continue;
    }
    try {
      const res = await send(new URL(AGGREGATE_UPLOAD_PATH, deps.cloudUrl), {
        method: "POST",
        headers: { ...auth, ...a.headers },
        body: a.body,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      // 409 already_stored: an earlier upload of the same answer got through.
      if (res.status === 200 || res.status === 409) out.uploaded++;
      else {
        out.failed++;
        deps.log?.(`[evolve] aggregate upload refused (${res.status} ${res.text.slice(0, 200)})`);
      }
    } catch (e) {
      out.failed++;
      deps.log?.(`[evolve] aggregate upload failed (${e instanceof Error ? e.message : e})`);
    }
  }
  return out;
}

export type PullLoop = {
  /** Runs one poll now unless one is running (returns null then). */
  tick(): Promise<PullResult | null>;
  stop(): void;
};

/** Polls every `intervalMs` (default 60 s); one poll at a time; never throws. */
export function startAggregatePull(deps: PullDeps & { intervalMs?: number }): PullLoop {
  let running: Promise<PullResult> | null = null;
  const tick = async () => {
    if (running) return null;
    running = pullOnce(deps).catch((e) => ({
      pulled: 0,
      uploaded: 0,
      failed: 0,
      error: String(e),
    }));
    try {
      const r = await running;
      if (r.error) deps.log?.(`[evolve] aggregate pull: ${r.error}`);
      return r;
    } finally {
      running = null;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? PULL_INTERVAL_SECONDS * 1000);
  timer.unref();
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}

/** A small request over node:http(s): Next patches global fetch. */
const nodeFetch: MiniFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    const req = send(
      url,
      {
        method: init.method,
        headers: { ...init.headers, ...(body ? { "content-length": body.length } : {}) },
        timeout: init.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
