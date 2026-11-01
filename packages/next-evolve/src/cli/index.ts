#!/usr/bin/env node
// `npx next-evolve <command>`. Minimal until the full CLI (E11): `migrate`, `aggregate`.
import { existsSync } from "node:fs";
import { createSql } from "../db/client";
import { migrate } from "../db/migrate";
import { aggregateCommand } from "./aggregate";
import { pullCommand } from "./pull";

const HELP = `Usage: next-evolve <command>

Commands:
  migrate [--url <postgres-url>]   Create or update the evolve schema in your database
                                   (default: $EVOLVE_DATABASE_URL, read from .env.local / .env)
  pull                             Fetch and verify the current bundle into
                                   .evolve/bundle.generated.ts (run as "prebuild"; never fails)
  aggregate [--upload]             Run the cloud's aggregate request on your local database and
                                   print the statistics; --upload sends them to Evolve Cloud
                                   (for local dev, where the cloud can't reach your app)
`;

function loadEnvFiles() {
  for (const f of [".env.local", ".env"]) {
    if (existsSync(f)) process.loadEnvFile(f); // never overrides variables already set
  }
}

async function runMigrate(args: string[]): Promise<number> {
  loadEnvFiles();
  const i = args.indexOf("--url");
  const url = i >= 0 ? args[i + 1] : process.env.EVOLVE_DATABASE_URL;
  if (!url) {
    console.error("next-evolve migrate: set EVOLVE_DATABASE_URL or pass --url");
    return 1;
  }
  const sql = createSql(url, { max: 1 });
  try {
    const r = await migrate(sql);
    console.warn(
      r.applied.length
        ? `Applied ${r.applied.join(", ")}`
        : `Up to date (${r.skipped.join(", ") || "nothing to apply"})`,
    );
    return 0;
  } catch (e) {
    console.error("next-evolve migrate failed:", e instanceof Error ? e.message : e);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "migrate") process.exitCode = await runMigrate(rest);
else if (cmd === "pull") {
  loadEnvFiles();
  process.exitCode = await pullCommand(rest, { env: process.env });
} else if (cmd === "aggregate") {
  loadEnvFiles();
  process.exitCode = await aggregateCommand(rest, { env: process.env });
} else {
  process.stdout.write(HELP);
  process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
}
