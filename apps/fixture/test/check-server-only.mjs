// Builds an app where a "use client" file imports the server-only `next-evolve`
// entry. The build must fail; if it succeeds, the server-only guard is broken.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const dir = new URL("./server-only-violation/", import.meta.url).pathname;
const r = spawnSync("pnpm", ["exec", "next", "build", dir], { encoding: "utf8" });
rmSync(`${dir}.next`, { recursive: true, force: true });
const out = `${r.stdout}\n${r.stderr}`;
if (r.status === 0) {
  console.error("check-server-only: build succeeded but should have failed");
  process.exit(1);
}
if (!/server-only/.test(out)) {
  console.error("check-server-only: build failed for another reason:\n", out.slice(-2000));
  process.exit(1);
}
console.warn("check-server-only: build failed on the server-only import, as expected");
