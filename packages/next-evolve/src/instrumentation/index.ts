import { type PullLoop, startAggregatePull } from "../aggregate/pull";
import { buildManifest, detectAppUrl, sdkVersion } from "../cloud/manifest";
import { pushToCloud } from "../cloud/push";
import { type EvolveConfig, resolveConfig } from "../config/config";
import type { Goals } from "../config/goals";
import { getSql } from "../db/client";
import { setRuntime } from "../server/runtime";
import { DEFAULT_CLOUD_URL, getBundleStore, isLongRunningNode } from "../store/runtime";

export type RegisterEvolveOptions = { config: EvolveConfig; goals?: Goals };

let registered = false;
let poll: ReturnType<typeof setInterval> | null = null;
let pull: PullLoop | null = null;

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
 * so the disk cache stays fresh between requests. With `aggregate.mode: "pull"`
 * it polls the cloud for aggregate requests every 60 s (AGG-2). Never throws.
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
    startPull(opts.config);
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

/** Pull mode: only on long-running Node, with a key, a webhook secret and a cloud URL. */
function startPull(config: EvolveConfig, env: Record<string, string | undefined> = process.env) {
  const cfg = resolveConfig(config);
  if (cfg.aggregate.mode !== "pull") return;
  if (!isLongRunningNode(env)) {
    console.warn(
      '[evolve] aggregate.mode "pull" needs a long-running Node server; on serverless use push',
    );
    return;
  }
  const cloudUrl = env.EVOLVE_CLOUD_URL ?? DEFAULT_CLOUD_URL;
  if (!cloudUrl || !env.EVOLVE_SECRET_KEY || !env.EVOLVE_WEBHOOK_SECRET) {
    console.warn("[evolve] aggregate pull needs EVOLVE_SECRET_KEY and EVOLVE_WEBHOOK_SECRET");
    return;
  }
  pull = startAggregatePull({
    config: cfg,
    env,
    cloudUrl,
    sql: () => getSql(cfg.databaseUrlEnv, env),
    sdkVersion: sdkVersion(),
    log: (m) => console.error(m),
  });
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
  pull?.stop();
  pull = null;
}
