// Fails the build if the unbundled output lost its module boundary markers.
import { readFileSync } from "node:fs";

const checks = [
  ["dist/client/evolve-script.js", (s) => s.startsWith('"use client"'), 'starts with "use client"'],
  ["dist/index.js", (s) => s.includes('import "server-only"'), 'imports "server-only"'],
  ["dist/server/index.js", (s) => s.includes('import "server-only"'), 'imports "server-only"'],
];
let failed = false;
for (const [file, ok, what] of checks) {
  if (!ok(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))) {
    console.error(`check-dist: ${file} must ${what}`);
    failed = true;
  }
}
if (failed) process.exit(1);
