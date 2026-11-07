import { parseSecretKey, SUPPORTED_PROTOCOLS } from "@next-evolve/protocol";
import { sdkVersion } from "../cloud/manifest";
import { type EvolveConfig, resolveConfig } from "../config/config";
import { type Goals, serializeGoals } from "../config/goals";
import { createBotDetector } from "../core/bots";
import { logRateLimited } from "../core/log";
import { getSql } from "../db/client";
import { globalConfigSettings, writeGlobalConfig } from "../store/global-config";
import { onDemand } from "../store/on-demand";
import { getBundleStore } from "../store/runtime";
import { handleAggregate } from "./aggregate-route";
import { handleCollect } from "./collect";
import { afterResponse, backgroundTask, runtimeWriter, scheduleFlush, setRuntime } from "./runtime";
import { handleSync, revalidateBundle } from "./sync-route";
import { handleTrack } from "./track-route";

export type EvolveHandlerOptions = {
  config: EvolveConfig;
  goals?: Goals;
  env?: Record<string, string | undefined>;
};

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

/**
 * Route handlers for `app/api/evolve/[...evolve]/route.ts`:
 * `POST collect` (beacon), `POST track` (bearer webhook), `POST aggregate`
 * (signed cloud request), `POST sync` (signed cloud webhook → pull the
 * bundle), `GET health`.
 */
export function createEvolveHandler(opts: EvolveHandlerOptions) {
  const cfg = resolveConfig(opts.config);
  if (opts.goals) serializeGoals(opts.goals); // throws early on mistakes
  setRuntime({ config: opts.config, goals: opts.goals, ...(opts.env ? { env: opts.env } : {}) });
  const isBot = createBotDetector(cfg.botPatterns);
  const env = () => opts.env ?? process.env;

  const action = (req: Request) => {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  };

  /** With a Global Config write token: every instance reads the bundle from there. */
  async function shareGlobalConfig(token: string): Promise<void> {
    const gc = globalConfigSettings(cfg.store, env());
    const site = parseSecretKey(env().EVOLVE_SECRET_KEY ?? "")?.siteId;
    if (gc && site) await writeGlobalConfig(gc, site, token);
  }

  async function post(req: Request): Promise<Response> {
    try {
      switch (action(req)) {
        case "collect": {
          const writer = runtimeWriter();
          const store = getBundleStore(cfg, { env: env() });
          // The poll peek() may start must finish before a serverless instance
          // is frozen, or the fetch hangs until it thaws (T19.5).
          const waitUntil = await backgroundTask();
          const later = await afterResponse();
          const status = await handleCollect(req, {
            config: cfg,
            goals: opts.goals,
            bundle: () => store?.peek(waitUntil) ?? null,
            ...(store ? { refreshBundle: onDemand(store).soon } : {}),
            // T31.1: a batch that waits for a refresh is recorded after the
            // response, then flushed (serverless; Node flushes on its timer).
            defer: (task) =>
              later(() =>
                task()
                  .then(() => (writer.mode === "node" ? undefined : writer.flush()))
                  .catch((e) => logRateLimited("collect", "collect failed", e)),
              ),
            isBot,
            writer,
          });
          if (status === 204) await scheduleFlush(writer);
          return new Response(null, { status });
        }
        case "track":
          return await handleTrack(req, {
            secret: env().EVOLVE_TRACK_SECRET,
            goals: opts.goals,
            writer: runtimeWriter(),
          });
        case "sync":
          return await handleSync(req, {
            env: env(),
            store: () => getBundleStore(cfg, { env: env() }),
            onSynced: async (token) => {
              await shareGlobalConfig(token);
              await revalidateBundle();
            },
            onCurrent: shareGlobalConfig,
          });
        case "aggregate":
          return await handleAggregate(req, {
            config: cfg,
            env: env(),
            sql: () => getSql(cfg.databaseUrlEnv, env()),
            sdkVersion: sdkVersion(),
          });
        default:
          return notFound();
      }
    } catch (e) {
      logRateLimited("handler", "evolve route failed", e);
      return Response.json({ error: "internal" }, { status: 500 });
    }
  }

  async function get(req: Request): Promise<Response> {
    if (action(req) !== "health") return notFound();
    return Response.json({
      ok: true,
      protocol: { supported: SUPPORTED_PROTOCOLS },
      db: Boolean(env()[cfg.databaseUrlEnv]),
    });
  }

  return { GET: get, POST: post };
}
