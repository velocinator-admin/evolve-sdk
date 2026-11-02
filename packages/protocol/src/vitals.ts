// Core Web Vitals histograms (protocol 1.1.0, Phase 2 spec §9.3). Additive to pv 1:
// requests may ask for `vitals`, responses may carry them; 1.0.0 readers ignore both.
import { z } from "zod";
import { ID_RE } from "./ids";

export const VITALS_METRICS = ["lcp", "cls", "inp"] as const;
export type VitalsMetric = (typeof VITALS_METRICS)[number];

/**
 * Upper edges per bin: `bins[i]` counts values ≤ `edges[i]` (and > the edge before),
 * `bins[edges.length]` counts the rest (open-ended). LCP and INP in ms, CLS in
 * thousandths. Fixed in pv 1: never edit an edge, only add a metric.
 */
export const VITALS_BINS = {
  lcp: [
    250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3500, 4000, 4500, 5000,
    6000, 7000, 8000, 10000, 12000, 15000, 20000, 30000,
  ],
  inp: [
    16, 32, 48, 64, 80, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500, 600, 800, 1000, 1500,
    2000,
  ],
  cls: [5, 10, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000],
} as const satisfies Record<VitalsMetric, readonly number[]>;

/** At most this many `vitals` rows in one aggregate response. */
export const MAX_VITALS_ROWS = 5_000;
/** `errors[].goal` of a response whose vitals query failed (no `vitals` then; keep the old histograms). */
export const VITALS_ERROR_GOAL = "$vitals";

export const isVitalsMetric = (m: unknown): m is VitalsMetric =>
  typeof m === "string" && (VITALS_METRICS as readonly string[]).includes(m);

/**
 * Bin index for a measured value: ms for LCP/INP, the unitless score for CLS
 * (binned in thousandths). Expects a finite value ≥ 0.
 */
export function binFor(metric: VitalsMetric, value: number): number {
  const edges: readonly number[] = VITALS_BINS[metric];
  // Rounded so 0.1 × 1000 can't land in the bin above 100 through float error.
  const x = metric === "cls" ? Math.round(value * 1e6) / 1e3 : value;
  let i = 0;
  while (i < edges.length && x > edges[i]!) i++;
  return i;
}

/** Aggregate request field: send vitals for cohort days ≥ `from`, same experiments and variants. */
export const vitalsRequestSchema = z.looseObject({ from: z.iso.date() });
export type VitalsRequest = z.infer<typeof vitalsRequestSchema>;

/**
 * One histogram per experiment × variant × metric × UTC day. Counts only, no
 * visitor ids. A metric this version doesn't know is accepted (any bin count)
 * so a newer SDK can add one; readers skip it.
 */
export const vitalsRowSchema = z
  .looseObject({
    exp: z.string().regex(ID_RE),
    var: z.string().regex(ID_RE),
    metric: z.string().regex(/^[a-z][a-z0-9]{1,15}$/),
    day: z.iso.date(),
    bins: z.array(z.number().int().nonnegative()).min(1).max(64),
  })
  .refine((r) => !isVitalsMetric(r.metric) || r.bins.length === VITALS_BINS[r.metric].length + 1, {
    message: "bins must have one count per edge plus the open last bin",
  });
export type VitalsRow = z.infer<typeof vitalsRowSchema>;
