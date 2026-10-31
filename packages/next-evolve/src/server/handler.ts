import { SUPPORTED_PROTOCOLS } from "@next-evolve/protocol";
import { type EvolveConfig, resolveConfig } from "../config/config";
import { type Goals, serializeGoals } from "../config/goals";
import { createBotDetector } from "../core/bots";
import { logRateLimited } from "../core/log";
import { getBundleStore } from "../store/runtime";
import { handleCollect } from "./collect";
import { runtimeWriter, scheduleFlush, setRuntime } from "./runtime";
import { handleTrack } from "./track-route";

export type EvolveHandlerOptions = {
  config: EvolveConfig;
  goals?: Goals;
  env?: Record<string, string | undefined>;
};

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

/**
 * Route handlers for `app/api/evolve/[...evolve]/route.ts`:
 * `POST collect` (beacon), `POST track` (bearer webhook), `GET health`.
 * Sync and aggregate arrive with M3/M4.
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

  async function POST(req: Request): Promise<Response> {
    try {
      switch (action(req)) {
        case "collect": {
          const writer = runtimeWriter();
          const store = getBundleStore(cfg, { env: env() });
          const status = await handleCollect(req, {
            config: cfg,
            goals: opts.goals,
            bundle: () => store?.peek() ?? null,
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
        default:
          return notFound();
      }
    } catch (e) {
      logRateLimited("handler", "evolve route failed", e);
      return Response.json({ error: "internal" }, { status: 500 });
    }
  }

  async function GET(req: Request): Promise<Response> {
    if (action(req) !== "health") return notFound();
    return Response.json({
      ok: true,
      protocol: { supported: SUPPORTED_PROTOCOLS },
      db: Boolean(env()[cfg.databaseUrlEnv]),
    });
  }

  return { GET, POST };
}
