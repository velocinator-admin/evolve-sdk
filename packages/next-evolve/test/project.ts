import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Writes a project from a { path: contents } map into a new temp dir (or `dir`). */
export function project(files: Record<string, string>, dir?: string): string {
  const root = dir ?? mkdtempSync(join(tmpdir(), "evolve-cli-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
