// `next-evolve push` (spec §16.2): sends the manifest (routes, goals,
// versions, app URL) to Evolve Cloud now. The app also sends it at startup
// (registerEvolve), so this matters for setup and CI.
import { spawnSync } from "node:child_process";
import { buildManifest, detectAppUrl } from "../cloud/manifest";
import { pushToCloud } from "../cloud/push";
import { type AppModules, loadAppModules } from "./load-app";

type Env = Record<string, string | undefined>;

export type PushDeps = {
  env: Env;
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** No success output (init prints its own). */
  quiet?: boolean;
  /** Inject the app's modules (tests). */
  load?: () => Promise<AppModules>;
};

export async function pushCommand(_args: string[], deps: PushDeps): Promise<number> {
  const out = deps.out ?? ((s) => console.warn(s));
  const err = deps.err ?? ((s) => console.error(s));
  const cwd = deps.cwd ?? process.cwd();
  if (!deps.env.EVOLVE_SECRET_KEY) {
    err("next-evolve push: set EVOLVE_SECRET_KEY");
    return 1;
  }
  let mods: AppModules;
  if (deps.load) mods = await deps.load();
  else {
    const r = await loadAppModules(cwd);
    if (!r.ok) {
      if (r.needsTs && process.argv[1] && !deps.load) {
        // Re-run with type stripping (Node < 22.18 has it behind a flag).
        const child = spawnSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
            process.argv[1],
            "push",
          ],
          {
            stdio: ["ignore", deps.quiet ? "ignore" : "inherit", "inherit"],
            cwd,
            env: { ...process.env, ...deps.env },
          },
        );
        return child.status ?? 1;
      }
      err(`next-evolve push: ${r.error}. The manifest is also sent when your app starts.`);
      return 1;
    }
    mods = r.mods;
  }
  const manifest = buildManifest(mods.config, mods.goals, { appUrl: detectAppUrl(deps.env) });
  const res = await pushToCloud("/v1/manifest", manifest, { env: deps.env });
  if (!res.ok) {
    err(`next-evolve push: the cloud refused the manifest (${res.status})`);
    return 1;
  }
  out(
    `next-evolve push: sent ${Object.keys(manifest.routes).length} route(s) and ${Object.keys(manifest.goals).length} goal(s)`,
  );
  return 0;
}
