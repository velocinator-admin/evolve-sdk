import { createRequire } from "node:module";
import {
  computeManifestHash,
  type Manifest,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
} from "@next-evolve/protocol";
import { type EvolveConfig, resolveConfig } from "../config/config";
import { type Goals, serializeGoals } from "../config/goals";

const require = createRequire(import.meta.url);
// Static specifiers so bundlers can resolve them.
const versionOf = (load: () => { version: string }): string | null => {
  try {
    return load().version;
  } catch {
    return null;
  }
};

/** This package's version (`0.0.0` if unknown). */
export function sdkVersion(): string {
  return versionOf(() => require("next-evolve/package.json")) ?? "0.0.0";
}

/** The manifest this app sends to the cloud (spec §8.4). Configuration only. */
export function buildManifest(
  config: EvolveConfig,
  goals: Goals | undefined,
  opts: { appUrl?: string | null } = {},
): Manifest {
  const routes: Manifest["routes"] = {};
  for (const [path, r] of resolveConfig(config).routes) routes[path] = { mode: r.mode };
  const serialized = goals ? serializeGoals(goals) : {};
  return {
    pv: PROTOCOL_VERSION,
    sdkVersion: sdkVersion(),
    protocol: { supported: [...SUPPORTED_PROTOCOLS] },
    nextVersion: versionOf(() => require("next/package.json")),
    routes,
    goals: serialized,
    hash: computeManifestHash({ routes, goals: serialized }),
    appUrl: opts.appUrl ?? null,
  };
}

/**
 * The app's public base URL: EVOLVE_APP_URL, else Vercel's production URL.
 * Null when unknown (the dashboard asks for it).
 */
export function detectAppUrl(env: Record<string, string | undefined> = process.env): string | null {
  if (env.EVOLVE_APP_URL) return env.EVOLVE_APP_URL.replace(/\/$/, "");
  if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return null;
}
