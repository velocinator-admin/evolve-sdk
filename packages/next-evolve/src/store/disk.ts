// Disk cache for long-running Node (spec §7.8): the last accepted bundle
// survives a restart, so the app serves it even when the cloud is down. Plain
// files; every read is verified like any other bundle.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const defaultDiskDir = (): string => tmpdir();
export const diskPath = (dir: string, site: string): string => join(dir, `evolve-${site}.jws`);

/** The cached token, or null (missing or unreadable). */
export function readDisk(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename). Never throws. */
export function writeDisk(path: string, token: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // A read-only filesystem just means no disk cache.
  }
}
