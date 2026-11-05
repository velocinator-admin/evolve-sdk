import {
  ANON_ID_RE,
  type BundlePayload,
  binFor,
  ID_RE,
  VITALS_METRICS,
  type VitalsMetric,
} from "@next-evolve/protocol";
import { z } from "zod";
import { normalizePath, type ResolvedConfig } from "../config/config";
import { type Goals, matchesPageviewGoal } from "../config/goals";
import { ANON_COOKIE, PREVIEW_COOKIE } from "../core/cookies";
import type { EventRow, ExposureRow, VitalsRow, Writer } from "../db/writer";
import { eventRow, utcDay } from "./events";

export const MAX_BATCH_BYTES = 32 * 1024;
export const MAX_BATCH_EVENTS = 50;

const path = z.string().min(1).max(512).startsWith("/");
const beaconEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("pv"), p: path }),
  z.object({
    t: z.literal("exp"),
    e: z.string().regex(ID_RE),
    v: z.string().regex(ID_RE),
    p: path,
  }),
  z.object({
    t: z.literal("ev"),
    n: z.string().min(1).max(100),
    p: path.optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ t: z.literal("id"), u: z.string().min(1).max(256) }),
  // Core Web Vitals for the page (0.5+): attributed to the batch's counted pairs on `p`.
  z.object({ t: z.literal("cwv"), m: z.enum(VITALS_METRICS), v: z.number(), p: path }),
]);

/** Largest plausible value per metric (ms for LCP/INP; CLS is a score); anything else is dropped. */
const VITALS_MAX: Record<VitalsMetric, number> = { lcp: 600_000, inp: 600_000, cls: 10 };
const vitalsValueOk = (m: VitalsMetric, v: number) =>
  Number.isFinite(v) && v >= 0 && v <= VITALS_MAX[m];
/** Beacon payload (spec §8.1). Unknown event types are skipped, not fatal. */
export const collectSchema = z.object({
  v: z.literal(1),
  events: z.array(z.unknown()).max(MAX_BATCH_EVENTS),
});
export type BeaconEvent = z.infer<typeof beaconEvent>;

export type CollectDeps = {
  config: ResolvedConfig;
  goals: Goals | undefined;
  bundle: () => BundlePayload | null;
  /**
   * Refreshes the bundle on demand (the store's shared, rate-limited
   * `onDemand(store).soon`). Called when a beacon names an experiment/variant
   * the current bundle doesn't know: the instance may be cold or behind the
   * proxy that assigned it, and dropping the pair would lose a real visit.
   */
  refreshBundle?: () => Promise<void>;
  /** Longest a beacon waits for refreshes, in total (default {@link COLLECT_REFRESH_CAP_MS}). */
  refreshCapMs?: number;
  isBot: (ua: string | null) => boolean;
  writer: Writer;
  now?: () => Date;
};

/**
 * Upper bound on a beacon's wait for refreshes: the on-demand window (5 s) plus
 * one bundle fetch (5 s timeout) and some slack. Beacons are fire-and-forget,
 * so this only holds the function invocation, never a visitor.
 */
export const COLLECT_REFRESH_CAP_MS = 12_000;
/** The first refresh may share a fetch that started before the publish; one more round covers that. */
const REFRESH_ROUNDS = 2;

/** Same-origin check: `Origin` must match the host; without it, `Sec-Fetch-Site` must say so. */
export function isSameOrigin(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === (host ?? new URL(req.url).host);
    } catch {
      return false;
    }
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}

function cookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * `POST /api/evolve/collect`. Validates synchronously and queues rows; the
 * caller flushes after the response. Returns the status code to send.
 */
export async function handleCollect(req: Request, deps: CollectDeps): Promise<number> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BATCH_BYTES) return 413;
  if (!isSameOrigin(req)) return 403;
  const text = await req.text();
  if (text.length > MAX_BATCH_BYTES) return 413;
  let parsed: z.infer<typeof collectSchema>;
  try {
    const r = collectSchema.safeParse(JSON.parse(text));
    if (!r.success) return 400;
    parsed = r.data;
  } catch {
    return 400;
  }

  // Not counted: bots, preview sessions and visitors without an Evolve id.
  const anon = cookie(req, ANON_COOKIE);
  if (deps.isBot(req.headers.get("user-agent"))) return 204;
  if (cookie(req, PREVIEW_COOKIE)) return 204;
  if (!anon || !ANON_ID_RE.test(anon)) return 204;
  if (deps.config.consent?.(req) === false) return 204;

  const events = parsed.events.flatMap((e) => {
    const r = beaconEvent.safeParse(e);
    return r.success ? [r.data] : [];
  });
  const now = deps.now?.() ?? new Date();
  let bundle = deps.bundle();
  const known = (e: string, v: string) => {
    const exp = bundle?.routing.experiments[e];
    return bundle?.variants[v]?.exp === e && Boolean(exp?.variants.some((x) => x.id === v));
  };
  const unknown = () => events.some((e) => e.t === "exp" && !known(e.e, e.v));
  if (deps.refreshBundle && unknown()) {
    const refresh = deps.refreshBundle;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<"cap">((r) => {
      timer = setTimeout(() => r("cap"), deps.refreshCapMs ?? COLLECT_REFRESH_CAP_MS);
    });
    for (let round = 0; round < REFRESH_ROUNDS && unknown(); round++) {
      const r = await Promise.race([refresh().catch(() => {}), capped]);
      bundle = deps.bundle();
      if (r === "cap") break;
    }
    clearTimeout(timer);
  }
  const exposures: ExposureRow[] = [];
  const rows: EventRow[] = [];
  /** Known pairs the batch reports per page; vitals for that page count for each of them. */
  const pairs = new Map<string, Map<string, string>>();
  const cwv = new Map<string, number>();
  let testedPageviews = 0;

  for (const e of events) {
    switch (e.t) {
      case "exp": {
        // Only pairs the local bundle knows about; anything else is noise or forgery.
        if (known(e.e, e.v)) {
          const p = normalizePath(e.p);
          if (!pairs.has(p)) pairs.set(p, new Map());
          pairs.get(p)!.set(e.e, e.v);
          exposures.push({
            experiment_id: e.e,
            anon_id: anon,
            variant_id: e.v,
            path: normalizePath(e.p),
            first_at: now,
          });
        }
        break;
      }
      case "pv": {
        const p = normalizePath(e.p);
        const running = (bundle?.routing.routes[p] ?? []).some(
          (id) => bundle?.routing.experiments[id]?.status === "running",
        );
        if (running && deps.config.routes.has(p)) testedPageviews++;
        if (matchesPageviewGoal(deps.goals, p)) {
          const row = eventRow("$pageview", { anonId: anon, path: p }, undefined, "browser", now);
          if (row) rows.push(row);
        }
        break;
      }
      case "ev": {
        const row = eventRow(
          e.n,
          { anonId: anon, props: e.props ?? null, path: e.p ? normalizePath(e.p) : null },
          deps.goals,
          "browser",
          now,
        );
        if (row) rows.push(row);
        break;
      }
      case "id":
        deps.writer.identities([{ anon_id: anon, user_id: e.u }]);
        break;
      case "cwv": {
        // One value per metric and page per batch (the beacon sends each once per page view).
        const k = `${e.m}\u0000${normalizePath(e.p)}`;
        if (vitalsValueOk(e.m, e.v) && !cwv.has(k)) cwv.set(k, e.v);
        break;
      }
    }
  }
  const day = utcDay(now);
  const vitals: VitalsRow[] = [];
  for (const [k, v] of cwv) {
    const [m, p] = k.split("\u0000") as [VitalsMetric, string];
    const bin = binFor(m, v);
    for (const [experiment_id, variant_id] of pairs.get(p) ?? []) {
      vitals.push({ experiment_id, variant_id, metric: m, day, bin, count: 1 });
    }
  }
  deps.writer.exposures(exposures);
  deps.writer.events(rows);
  deps.writer.usage(day, testedPageviews);
  deps.writer.vitals(vitals);
  return 204;
}
