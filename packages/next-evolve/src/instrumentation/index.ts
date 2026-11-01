import { buildManifest, detectAppUrl } from "../cloud/manifest";
import { pushToCloud } from "../cloud/push";
import type { EvolveConfig } from "../config/config";
import type { Goals } from "../config/goals";
import { setRuntime } from "../server/runtime";

export type RegisterEvolveOptions = { config: EvolveConfig; goals?: Goals };

let registered = false;

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
 * (goals, routes, versions, app URL; spec §8.4), once per process. Never
 * throws. Background polling and the disk cache arrive with T7.4.
 */
export async function registerEvolve(opts: RegisterEvolveOptions): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    setRuntime({ config: opts.config, goals: opts.goals });
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
}
