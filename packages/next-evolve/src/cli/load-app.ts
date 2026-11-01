// Loads the app's evolve.config / evolve.goals in the CLI (push, doctor).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvolveConfig } from "../config/config";
import type { Goals } from "../config/goals";

export type AppModules = { config: EvolveConfig; goals?: Goals };

const find = (root: string, name: string) =>
  ["ts", "mts", "js", "mjs"].map((e) => join(root, `${name}.${e}`)).find((p) => existsSync(p));

/** True when this Node can import .ts files (type stripping on). */
export const canImportTs = (): boolean =>
  Boolean((process.features as { typescript?: unknown }).typescript) ||
  process.execArgv.some((a) => a.includes("strip-types"));

export async function loadAppModules(
  root: string,
): Promise<
  { ok: true; mods: AppModules; files: string[] } | { ok: false; error: string; needsTs?: boolean }
> {
  const configPath = find(root, "evolve.config");
  if (!configPath) return { ok: false, error: "no evolve.config.ts (run npx next-evolve init)" };
  const goalsPath = find(root, "evolve.goals");
  const files = [configPath, ...(goalsPath ? [goalsPath] : [])];
  if (files.some((f) => /\.m?ts$/.test(f)) && !canImportTs()) {
    return { ok: false, error: "this Node can't load .ts files", needsTs: true };
  }
  try {
    const c = await import(pathToFileURL(configPath).href);
    const g = goalsPath ? await import(pathToFileURL(goalsPath).href) : undefined;
    return {
      ok: true,
      mods: { config: c.default ?? c, goals: g ? (g.default ?? g) : undefined },
      files,
    };
  } catch (e) {
    return {
      ok: false,
      error: `couldn't load ${configPath} (${e instanceof Error ? e.message : e})`,
    };
  }
}
