import { ANON_COOKIE } from "../core/cookies";
import { logRateLimited } from "../core/log";
import { eventRow, type TrackInput } from "./events";
import { getRuntime, runtimeWriter, scheduleFlush } from "./runtime";

export type TrackOptions = Omit<TrackInput, "path">;

async function cookieAnonId(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(ANON_COOKIE)?.value ?? null;
  } catch {
    return null; // outside a request (scripts, cron)
  }
}

/**
 * Records a server-side event in the customer DB. Never throws. Without
 * `anonId` it uses the visitor's `evolve_id` cookie when called in a request.
 */
async function track(name: string, opts: TrackOptions = {}): Promise<void> {
  try {
    const rt = getRuntime();
    const anonId = opts.anonId !== undefined ? opts.anonId : await cookieAnonId();
    const row = eventRow(name, { ...opts, anonId }, rt.goals, "server");
    if (!row) return;
    const w = runtimeWriter(rt);
    w.events([row]);
    await scheduleFlush(w);
  } catch (e) {
    logRateLimited("track", "evolve.track failed", e);
  }
}

/**
 * Links a visitor (the `evolve_id` cookie, or `anonId`) to your user id, so
 * events on other devices or from your server count for their experiments.
 * The first link for a visitor wins. Never throws.
 */
async function identify(userId: string, opts: { anonId?: string } = {}): Promise<void> {
  try {
    const anonId = opts.anonId ?? (await cookieAnonId());
    if (!anonId || !userId) return;
    const w = runtimeWriter();
    w.identities([{ anon_id: anonId.slice(0, 64), user_id: String(userId).slice(0, 256) }]);
    await scheduleFlush(w);
  } catch (e) {
    logRateLimited("identify", "evolve.identify failed", e);
  }
}

export const evolve = { track, identify };
