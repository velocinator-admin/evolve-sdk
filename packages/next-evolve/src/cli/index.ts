#!/usr/bin/env node
// `npx next-evolve <command>` (spec §16).
import { existsSync } from "node:fs";
import { aggregateCommand } from "./aggregate";
import { migrateCommand } from "./migrate";
import { pullCommand } from "./pull";

type Env = Record<string, string | undefined>;
type Command = {
  usage: string;
  summary: string;
  run: (args: string[], env: Env) => Promise<number>;
};

const COMMANDS: Record<string, Command> = {
  migrate: {
    usage: "migrate [--url <postgres-url>]",
    summary: "Create or update the evolve schema in your database ($EVOLVE_DATABASE_URL)",
    run: (args, env) => migrateCommand(args, { env }),
  },
  pull: {
    usage: "pull",
    summary: 'Write the verified bundle to .evolve/bundle.generated.ts (run as "prebuild")',
    run: (args, env) => pullCommand(args, { env }),
  },
  aggregate: {
    usage: "aggregate [--upload]",
    summary: "Run the cloud's aggregate request on your local DB (--upload sends the result)",
    run: (args, env) => aggregateCommand(args, { env }),
  },
};

function help(): string {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length)) + 2;
  return `Usage: next-evolve <command>\n\nCommands:\n${Object.values(COMMANDS)
    .map((c) => `  ${c.usage.padEnd(width)}${c.summary}`)
    .join("\n")}\n\nEnv is read from .env.local and .env (never overriding what's set).\n`;
}

function loadEnvFiles() {
  for (const f of [".env.local", ".env"]) {
    if (existsSync(f)) process.loadEnvFile(f); // never overrides variables already set
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const command = cmd ? COMMANDS[cmd] : undefined;
if (command) {
  loadEnvFiles();
  process.exitCode = await command.run(rest, process.env);
} else {
  process.stdout.write(help());
  process.exitCode = cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 1 : 0;
}
