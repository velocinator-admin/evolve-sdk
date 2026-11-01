// `next-evolve migrate` (spec §8.3): creates or updates the `evolve` schema.
import { createSql } from "../db/client";
import { migrate } from "../db/migrate";
import { parseFlags } from "./args";

type Env = Record<string, string | undefined>;

export async function migrateCommand(
  args: string[],
  deps: { env: Env; out?: (s: string) => void; err?: (s: string) => void },
): Promise<number> {
  const out = deps.out ?? ((s) => console.warn(s));
  const err = deps.err ?? ((s) => console.error(s));
  const parsed = parseFlags(args, { url: { type: "string" } });
  if (!parsed.ok) {
    err(`next-evolve migrate: ${parsed.error}`);
    return 1;
  }
  const url = parsed.flags.url ?? deps.env.EVOLVE_DATABASE_URL;
  if (!url) {
    err("next-evolve migrate: set EVOLVE_DATABASE_URL or pass --url");
    return 1;
  }
  const sql = createSql(url, { max: 1 });
  try {
    const r = await migrate(sql);
    out(
      r.applied.length
        ? `Applied ${r.applied.join(", ")}`
        : `Up to date (${r.skipped.join(", ") || "nothing to apply"})`,
    );
    return 0;
  } catch (e) {
    err(`next-evolve migrate failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
