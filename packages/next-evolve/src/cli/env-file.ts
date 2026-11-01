import { readFileSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** Reads a value from the app's .env.local / .env without touching process.env. */
export function fileEnv(root: string): Env {
  const out: Env = {};
  for (const f of [".env", ".env.local"]) {
    try {
      for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
      }
    } catch {}
  }
  return out;
}
