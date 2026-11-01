import type { SerializedGoal } from "@next-evolve/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freshSchema, testSql } from "../../test/db";
import { runAttribution } from "./attribution";

// T8.1 acceptance: 50k exposures / 1M events, p95 < 5 s per attribution query.
const sql = testSql();
const EXPOSURES = 50_000;
const EVENTS = 1_000_000;

beforeAll(async () => {
  await freshSchema(sql);
  // 50k exposed visitors over 10 days, half of them identified.
  await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path)
    select 'k3j9x2', 'v' || g, case when g % 2 = 0 then 'a8f2l1' else 'c1d2e3' end,
      timestamptz '2026-11-01T00:00:00Z' + (g % 864000) * interval '1 second', '/'
    from generate_series(1, ${EXPOSURES}::int) g`;
  await sql`insert into evolve.identities (anon_id, user_id)
    select 'v' || g, 'u' || (g / 2) from generate_series(1, ${EXPOSURES}::int, 2) g`;
  // 1M events over 12 days from 200k visitors (exposed or not), 10 event names.
  await sql`insert into evolve.events (ts, name, anon_id, user_id, value, source, path)
    select timestamptz '2026-11-01T00:00:00Z' + (random() * 1036800) * interval '1 second',
      'ev' || (g % 10), 'v' || (1 + (random() * 200000)::int),
      case when g % 50 = 0 then 'u' || (random() * 25000)::int end,
      case when g % 3 = 0 then round((random() * 100)::numeric, 2)::float8 end,
      'browser', '/'
    from generate_series(1, ${EVENTS}::int) g`;
  await sql`analyze evolve.exposures`;
  await sql`analyze evolve.events`;
  await sql`analyze evolve.identities`;
}, 180_000);
afterAll(() => sql.end());

const goal = (unit: "visitor" | "user"): SerializedGoal => ({
  kind: "event",
  event: "ev3",
  window: "7d",
  unit,
  source: null,
  where: null,
  value: null,
  direction: "increase",
});

for (const unit of ["visitor", "user"] as const) {
  it(`${unit} unit: p95 < 5 s`, async () => {
    const times: number[] = [];
    let units = 0;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const rows = await runAttribution(sql, {
        experimentId: "k3j9x2",
        variants: ["a8f2l1", "c1d2e3"],
        goalKey: "g",
        goal: goal(unit),
        asOf: new Date("2026-11-13T00:00:00Z"),
        cohortsFrom: "2026-11-01",
      });
      times.push(performance.now() - t);
      units = rows.reduce((s, r) => s + r.n, 0);
    }
    times.sort((a, b) => a - b);
    console.warn(`attribution ${unit}: ${times.map((t) => Math.round(t)).join(", ")} ms`);
    expect(units).toBe(unit === "visitor" ? EXPOSURES : EXPOSURES / 2);
    expect(times[times.length - 1]).toBeLessThan(5_000);
  }, 60_000);
}
