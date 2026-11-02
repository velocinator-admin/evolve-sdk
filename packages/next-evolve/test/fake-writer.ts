import type { EventRow, ExposureRow, IdentityRow, VitalsRow, Writer } from "../src/db/writer";

export type FakeWriter = Writer & {
  rows: {
    exposures: ExposureRow[];
    events: EventRow[];
    identities: IdentityRow[];
    usage: Map<string, number>;
    vitals: VitalsRow[];
  };
  flushes: number;
};

/** Records rows instead of writing them. */
export function fakeWriter(mode: "node" | "serverless" = "serverless"): FakeWriter {
  const rows = {
    exposures: [] as ExposureRow[],
    events: [] as EventRow[],
    identities: [] as IdentityRow[],
    usage: new Map<string, number>(),
    vitals: [] as VitalsRow[],
  };
  const w: FakeWriter = {
    mode,
    rows,
    flushes: 0,
    exposures: (r) => void rows.exposures.push(...r),
    events: (r) => void rows.events.push(...r),
    identities: (r) => void rows.identities.push(...r),
    usage: (d, n) => {
      if (n > 0) rows.usage.set(d, (rows.usage.get(d) ?? 0) + n);
    },
    vitals: (r) => void rows.vitals.push(...r),
    pending: () => 0,
    flush: async () => {
      w.flushes++;
    },
  };
  return w;
}
