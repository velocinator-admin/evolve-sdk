// File changes `init` wants to make, collected first so `--dry-run` can print
// them as a diff and a re-run can see there's nothing to do.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FileChange = { path: string; before: string | null; after: string | null };

export class Plan {
  private readonly files = new Map<string, string | null>();
  /** Things the developer must do by hand (printed at the end). */
  readonly manual: string[] = [];
  readonly notes: string[] = [];

  constructor(readonly root: string) {}

  private disk(path: string): string | null {
    const p = join(this.root, path);
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  }

  /** Current content, including planned changes. */
  read(path: string): string | null {
    return this.files.has(path) ? this.files.get(path)! : this.disk(path);
  }

  exists(path: string): boolean {
    return this.read(path) !== null;
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** Writes only if the file doesn't exist yet. Returns whether it will be created. */
  create(path: string, content: string): boolean {
    if (this.exists(path)) return false;
    this.write(path, content);
    return true;
  }

  remove(path: string): void {
    this.files.set(path, null);
  }

  move(from: string, to: string): void {
    const c = this.read(from);
    if (c === null) return;
    this.write(to, c);
    this.remove(from);
  }

  /** Changes that differ from disk, sorted by path. */
  changes(): FileChange[] {
    const out: FileChange[] = [];
    for (const [path, after] of this.files) {
      const before = this.disk(path);
      if (before !== after) out.push({ path, before, after });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  apply(): void {
    for (const c of this.changes()) {
      const p = join(this.root, c.path);
      if (c.after === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.after);
      }
    }
  }
}

/** A readable diff of the plan: whole new files, line diffs for changed ones. */
export function renderDiff(changes: FileChange[]): string {
  const out: string[] = [];
  for (const raw of changes) {
    const c = /(^|\/)\.env/.test(raw.path) ? maskEnv(raw) : raw;
    if (c.before === null) {
      out.push(`+++ ${c.path} (new)`);
      for (const l of c.after!.replace(/\n$/, "").split("\n")) out.push(`+ ${l}`);
    } else if (c.after === null) {
      out.push(`--- ${c.path} (removed)`);
    } else {
      out.push(`*** ${c.path}`);
      out.push(...lineDiff(c.before, c.after));
    }
    out.push("");
  }
  return out.join("\n");
}

/** Line diff via LCS, with 1 line of context around changes. */
function lineDiff(a: string, b: string): string[] {
  const x = a.replace(/\n$/, "").split("\n");
  const y = b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: [" " | "-" | "+", string][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push([" ", x[i]!]);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push(["-", x[i++]!]);
    else ops.push(["+", y[j++]!]);
  }
  while (i < n) ops.push(["-", x[i++]!]);
  while (j < m) ops.push(["+", y[j++]!]);
  const changed = (k: number) => ops[k] !== undefined && ops[k]![0] !== " ";
  const lines: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (changed(k) || changed(k - 1) || changed(k + 1)) {
      lines.push(`${o[0]} ${o[1]}`);
      skipped = false;
    } else if (!skipped) {
      lines.push("  …");
      skipped = true;
    }
  });
  return lines;
}

/** Never print secrets: `KEY=value` → `KEY=…` in env files. */
function maskEnv(c: FileChange): FileChange {
  const mask = (s: string | null) => s?.replace(/^(\s*[A-Z0-9_]+\s*=).+$/gm, "$1…") ?? null;
  return { ...c, before: mask(c.before), after: mask(c.after) };
}
