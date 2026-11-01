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

/**
 * A draw in [0, 1) for a key, e.g. `<exp>:t` (traffic) and `<exp>:v` (variant).
 * `Math.random` fits too (it ignores the key).
 */
export type Draw = (key: string) => number;

/**
 * Deterministic draws for one visitor: the same `evolve_id` and experiment give
 * the same assignment on every request, so concurrent first requests (a link
 * prefetch and the click that follows) can't assign different variants.
 * FNV-1a with a murmur3 finalizer; uniform enough for traffic splits, not crypto.
 */
export function visitorDraw(anonId: string): Draw {
  return (key) => {
    let h = 0x811c9dc5;
    const s = `${anonId}|${key}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 0x1_0000_0000;
  };
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
  rand: Draw,
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
    if (rand(`${exp}:t`) >= e.traffic) {
      assigned.set(exp, EXCLUDED);
      pairs.push({ exp, var: e.control, counted: false });
      continue;
    }
    const v = weightedPick(e.variants, rand(`${exp}:v`));
    assigned.set(exp, v);
    pairs.push({ exp, var: v, counted: true });
  }
  return { pairs, assigned, changed };
}
