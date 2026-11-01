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
 * (goals, routes, versions, app URL; spec §8.4), once per process. On
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
    const manifest = buildManifest(opts.config, opts.goals, { appUrl: detectAppUrl() });
    const res = await pushToCloud("/v1/manifest", manifest);
    if (!res.ok && res.status !== "no_key") {
      console.error(`[evolve] manifest push failed (${res.status})`);
    }
  } catch (e) {
    console.error("[evolve] registerEvolve failed", e);
  }
}

/** Test helper. */
export function resetRegisterEvolve(): void {
  registered = false;
  if (poll) clearInterval(poll);
  poll = null;
}
