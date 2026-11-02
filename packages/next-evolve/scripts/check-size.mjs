// Client budget (spec §5.9; Phase 2 §9.4 with Core Web Vitals): the beacon ships ≤ 3 KB gzipped.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const LIMIT = 3072;
const files = ["dist/client/index.js", "dist/client/beacon.js", "dist/client/evolve-script.js"];
const src = files.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
const size = gzipSync(src, { level: 9 }).length;
if (size > LIMIT) {
  console.error(`check-size: client is ${size} B gz, over the ${LIMIT} B budget`);
  process.exit(1);
}
console.warn(`check-size: client ${size} B gz (budget ${LIMIT} B)`);
