import { buildManifest, detectAppUrl } from "../cloud/manifest";
import { pushToCloud } from "../cloud/push";
import { type EvolveConfig, resolveConfig } from "../config/config";
import type { Goals } from "../config/goals";
import { setRuntime } from "../server/runtime";
import { getBundleStore, isLongRunningNode } from "../store/runtime";

export type RegisterEvolveOptions = { config: EvolveConfig; goals?: Goals };

let registered = false;
let poll: ReturnType<typeof setInterval> | null = null;

/**
 * Call from `instrumentation.ts` `register()`:
 *
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === "nodejs") {
 *       const { registerEvolve } = await import("next-evolve/instrumentation");
 *       await registerEvolve({ config, goals });
 *     }
 *   }
 *
 * Registers the goals for this process and pushes the manifest to the cloud
 * (goals, routes, versions, app URL; spec §8.4), once per process, in the
 * background (it resolves without waiting for the cloud). On
 * long-running Node it also polls the bundle in the background (spec §7.5),
 * so the disk cache stays fresh between requests. Never throws.
 */
export async function registerEvolve(opts: RegisterEvolveOptions): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    setRuntime({ config: opts.config, goals: opts.goals });
    if (isLongRunningNode()) {
      const cfg = resolveConfig(opts.config);
      const store = getBundleStore(cfg);
      if (store) {
        void store.refresh();
        poll = setInterval(() => void store.refresh(), cfg.pollSeconds * 1000);
        poll.unref();
      }
    }
    // Not awaited: Next awaits register() before an instance serves its first
    // request, so awaiting the push would put a network call to the cloud (up
    // to its 3 s timeout) in front of every cold instance's first request.
    const manifest = buildManifest(opts.config, opts.goals, { appUrl: detectAppUrl() });
    manifestPush = pushToCloud("/v1/manifest", manifest).then((res) => {
      if (!res.ok && res.status !== "no_key") {
        console.error(`[evolve] manifest push failed (${res.status})`);
      }
    });
  } catch (e) {
    console.error("[evolve] registerEvolve failed", e);
  }
}

let manifestPush: Promise<void> | null = null;

/** Test helper: the background manifest push started by registerEvolve, if any. */
export function pendingManifestPush(): Promise<void> {
  return manifestPush ?? Promise.resolve();
}

/** Test helper. */
export function resetRegisterEvolve(): void {
  registered = false;
  manifestPush = null;
  if (poll) clearInterval(poll);
  poll = null;
}
