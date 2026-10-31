import type { BundlePayload, CodePair } from "@next-evolve/protocol";
import { EXCLUDED } from "./cookies";

type Variant = { id: string; w: number };

/** Picks a variant id for r ∈ [0, 1) proportionally to weight (w > 0 only). */
export function weightedPick(variants: readonly Variant[], r: number): string {
  let total = 0;
  for (const v of variants) if (v.w > 0) total += v.w;
  let acc = 0;
  let last = variants[0]!.id;
  for (const v of variants) {
    if (v.w <= 0) continue;
    acc += v.w / total;
    last = v.id;
    if (r < acc) return v.id;
  }
  return last; // float rounding at r ≈ 1
}

export type Assignment = {
  /** Pairs for the variant code (unsorted; `encodeCode` sorts). */
  pairs: CodePair[];
  /** Assignments to write back to `evolve_a`. */
  assigned: Map<string, string>;
  /** Whether `assigned` differs from the cookie that came in. */
  changed: boolean;
};

/**
 * Assigns a visitor to the experiments on `path` (spec §6.3). Pure: no I/O.
 * Sticky: an active assignment is kept. Completed experiments render their
 * winner and aren't counted. Cookie entries for experiments no longer in the
 * bundle are pruned.
 */
export function assign(
  bundle: BundlePayload,
  path: string,
  cookie: ReadonlyMap<string, string>,
  rand: () => number,
): Assignment {
  const { experiments, routes } = bundle.routing;
  const assigned = new Map<string, string>();
  let changed = false;
  for (const [exp, v] of cookie) {
    if (experiments[exp]) assigned.set(exp, v);
    else changed = true;
  }

  const pairs: CodePair[] = [];
  for (const exp of routes[path] ?? []) {
    const e = experiments[exp];
    if (!e) continue;
    if (e.status === "completed") {
      pairs.push({ exp, var: e.winner!, counted: false });
      continue;
    }
    const a = assigned.get(exp);
    if (a === EXCLUDED) {
      pairs.push({ exp, var: e.control, counted: false });
      continue;
    }
    if (a !== undefined && e.variants.some((v) => v.id === a && v.w > 0)) {
      pairs.push({ exp, var: a, counted: true });
      continue;
    }
    changed = true;
    if (rand() >= e.traffic) {
      assigned.set(exp, EXCLUDED);
      pairs.push({ exp, var: e.control, counted: false });
      continue;
    }
    const v = weightedPick(e.variants, rand());
    assigned.set(exp, v);
    pairs.push({ exp, var: v, counted: true });
  }
  return { pairs, assigned, changed };
}
