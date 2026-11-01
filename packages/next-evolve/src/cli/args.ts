import { parseArgs } from "node:util";

export type FlagSpec = Record<string, { type: "string" | "boolean"; short?: string }>;

/** Parses `--flag value` / `--flag`; unknown flags are an error (returned, not thrown). */
export function parseFlags<S extends FlagSpec>(
  args: string[],
  spec: S,
):
  | { ok: true; flags: { [K in keyof S]?: S[K]["type"] extends "boolean" ? boolean : string } }
  | { ok: false; error: string } {
  try {
    const { values } = parseArgs({ args, options: spec, strict: true, allowPositionals: false });
    return { ok: true, flags: values as never };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
