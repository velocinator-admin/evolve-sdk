import { type EvolveConfig, resolveConfig } from "../config/config";
import type { Goals } from "../config/goals";
import { getSql } from "../db/client";
import { getWriter, type Writer } from "../db/writer";

type Env = Record<string, string | undefined>;

export type EvolveRuntime = {
  config?: EvolveConfig;
  goals?: Goals;
  /** Inject a writer (tests). */
  writer?: Writer;
  env?: Env;
};

const KEY = Symbol.for("next-evolve.runtime");
const state = (): EvolveRuntime => {
  const g = globalThis as { [KEY]?: EvolveRuntime };
  g[KEY] ??= {};
  return g[KEY];
};

/**
 * Makes the app's config and goals known to `evolve.track()` and friends.
 * Called by `createEvolveHandler()` and `registerEvolve()`.
 */
export function setRuntime(r: EvolveRuntime): void {
  Object.assign(state(), r);
}

export function getRuntime(): EvolveRuntime {
  return state();
}

/** Test helper. */
export function resetRuntime(): void {
  const s = state();
  for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k];
}

export function runtimeWriter(r: EvolveRuntime = state()): Writer {
  if (r.writer) return r.writer;
  const urlEnv = r.config ? resolveConfig(r.config).databaseUrlEnv : "EVOLVE_DATABASE_URL";
  const env = r.env ?? process.env;
  return getWriter(() => getSql(urlEnv, env), urlEnv);
}

/**
 * Flushes after the response on serverless hosts (`after()`), or right away
 * outside a request. Long-running Node flushes on its own timer.
 */
export async function scheduleFlush(writer: Writer): Promise<void> {
  if (writer.mode === "node") return;
  try {
    const { after } = await import("next/server");
    after(() => writer.flush());
  } catch {
    await writer.flush();
  }
}

/**
 * `waitUntil` for background work started during a request: Next's `after()`
 * on a request, so serverless hosts keep the instance alive until it settles.
 * Undefined outside Next (tests, scripts), where nothing freezes the process.
 */
export async function backgroundTask(): Promise<((p: Promise<unknown>) => void) | undefined> {
  try {
    const { after } = await import("next/server");
    return (p) => {
      try {
        after(() => p);
      } catch {
        // Not inside a request scope: nothing to keep alive.
      }
    };
  } catch {
    return undefined;
  }
}

/**
 * Schedules a task to run after the response (Next's `after()`). The returned
 * function says false when it can't (outside Next or a request scope), so the
 * caller runs the task itself.
 */
export async function afterResponse(): Promise<(task: () => Promise<unknown>) => boolean> {
  let after: ((task: () => unknown) => void) | undefined;
  try {
    ({ after } = await import("next/server"));
  } catch {}
  return (task) => {
    if (!after) return false;
    try {
      after(task);
      return true;
    } catch {
      return false;
    }
  };
}
