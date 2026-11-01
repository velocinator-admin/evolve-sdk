// `next-evolve connect [--test] [--app-url <url>]` (spec §16.2): checks the
// key, registers the app URL, and with --test asks the cloud to reach the
// app's sync and aggregate routes.
import { parseSecretKey } from "@next-evolve/protocol";
import { parseFlags } from "./args";
import { getSiteInfo, putAppUrl, runCloudTest } from "./cloud";

type Env = Record<string, string | undefined>;

export async function connectCommand(
  args: string[],
  deps: { env: Env; fetch?: typeof fetch; out?: (s: string) => void; err?: (s: string) => void },
): Promise<number> {
  const out = deps.out ?? ((s) => console.warn(s));
  const err = deps.err ?? ((s) => console.error(s));
  const p = parseFlags(args, { test: { type: "boolean" }, "app-url": { type: "string" } });
  if (!p.ok) {
    err(`next-evolve connect: ${p.error}`);
    return 1;
  }
  const key = deps.env.EVOLVE_SECRET_KEY ?? "";
  if (!parseSecretKey(key)) {
    err("next-evolve connect: set EVOLVE_SECRET_KEY (evk_live_…)");
    return 1;
  }
  const site = await getSiteInfo(deps, key);
  if (!site.ok) {
    err(`next-evolve connect: ${site.error}`);
    return 1;
  }
  out(`✓ Connected to "${site.site.name}" (${site.site.id})`);
  if (p.flags["app-url"]) {
    const r = await putAppUrl(deps, key, p.flags["app-url"]);
    if (!r.ok) {
      err(`✗ App URL: ${r.error}`);
      return 1;
    }
    out(`✓ App URL: ${r.appUrl}`);
  } else if (site.site.appUrl) out(`  App URL: ${site.site.appUrl}`);
  if (!p.flags.test) return 0;

  const t = await runCloudTest(deps, key);
  if (!t.ok) {
    err(`✗ Connection test: ${t.error}`);
    return 1;
  }
  const line = (name: string, c: { ok: boolean; detail?: string }) =>
    `${c.ok ? "✓" : "✗"} ${name}${c.detail ? ` (${c.detail})` : ""}`;
  out(line("Sync webhook reaches the app", t.webhook));
  out(line("Aggregate route answers (signed dry run)", t.aggregate));
  return t.webhook.ok && t.aggregate.ok ? 0 : 1;
}
