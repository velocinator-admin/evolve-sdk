import type { AggregateRow, SerializedGoal } from "@next-evolve/protocol";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { freshSchema, testSql } from "../../test/db";
import { type AttributionInput, runAttribution } from "./attribution";

const sql = testSql();
beforeEach(() => freshSchema(sql));
afterAll(() => sql.end());

const EXP = "k3j9x2";
const A = "a8f2l1";
const B = "c1d2e3";
const T0 = Date.parse("2026-11-20T10:00:00Z");
const at = (hours: number) => new Date(T0 + hours * 3_600_000);

async function expose(anon: string, variant: string, hours: number, segment: string | null = null) {
  await sql`insert into evolve.exposures (experiment_id, anon_id, variant_id, first_at, path, segment)
    values (${EXP}, ${anon}, ${variant}, ${at(hours)}, '/', ${segment})`;
}
type Ev = {
  name?: string;
  anon?: string | null;
  user?: string | null;
  hours: number;
  value?: number | null;
  props?: Record<string, unknown> | null;
  goalValues?: Record<string, number> | null;
  source?: string;
  path?: string | null;
};
async function event(e: Ev) {
  await sql`insert into evolve.events (ts, name, anon_id, user_id, value, goal_values, props, source, path)
    values (${at(e.hours)}, ${e.name ?? "signed_up"}, ${e.anon ?? null}, ${e.user ?? null},
      ${e.value ?? null}, ${e.goalValues ? JSON.stringify(e.goalValues) : null}::text::jsonb,
      ${e.props ? JSON.stringify(e.props) : null}::text::jsonb, ${e.source ?? "browser"}, ${e.path ?? null})`;
}
async function link(anon: string, user: string) {
  await sql`insert into evolve.identities (anon_id, user_id) values (${anon}, ${user})`;
}

const eventGoal = (
  over: Partial<Extract<SerializedGoal, { kind: "event" }>> = {},
): SerializedGoal => ({
  kind: "event",
  event: "signed_up",
  window: "1d",
  unit: "visitor",
  source: null,
  where: null,
  value: null,
  direction: "increase",
  ...over,
});

const run = (goal: SerializedGoal, over: Partial<AttributionInput> = {}) =>
  runAttribution(sql, {
    experimentId: EXP,
    variants: [A, B],
    goalKey: "goal",
    goal,
    asOf: at(100),
    cohortsFrom: "2026-11-01",
    ...over,
  });

const zero = { n: 0, c: 0, s1: 0, s2: 0, mn: 0, mc: 0, ms1: 0, ms2: 0 };
const row = (
  variant: string,
  day: string,
  stats: Partial<typeof zero>,
  seg = "main",
): AggregateRow => ({
  exp: EXP,
  var: variant,
  goal: "goal",
  seg,
  day,
  ...zero,
  ...stats,
});

describe("attribution (visitor unit, event goal)", () => {
  it("counts each unit once, only for events inside [first exposure, + window)", async () => {
    await expose("a1", A, 0);
    await expose("a2", A, 1);
    await expose("a3", A, 2);
    await expose("b1", B, 0);
    await expose("b2", B, 3);
    await event({ anon: "a1", hours: 5 }); // counts
    await event({ anon: "a2", hours: 1 + 24 }); // window ends exactly here: excluded
    await event({ anon: "a3", hours: 1 }); // before exposure: excluded
    await event({ anon: "b1", hours: 2 }); // counts…
    await event({ anon: "b1", hours: 3 }); // …once per unit
    await event({ anon: "b2", hours: 4, name: "other" }); // another event

    expect(await run(eventGoal())).toEqual([
      row(A, "2026-11-20", { n: 3, c: 1, mn: 3, mc: 1 }),
      row(B, "2026-11-20", { n: 2, c: 1, mn: 2, mc: 1 }),
    ]);
  });

  it("splits units by cohort day (UTC) and caps the window and maturity at asOf", async () => {
    await expose("a1", A, 0); // 2026-11-20
    await expose("a2", A, 20); // 2026-11-21 06:00
    await event({ anon: "a1", hours: 10 });
    await event({ anon: "a2", hours: 26 }); // after asOf: excluded
    // asOf = 25h: a1's window (ends 24h) is over → mature; a2's isn't.
    expect(await run(eventGoal(), { asOf: at(25) })).toEqual([
      row(A, "2026-11-20", { n: 1, c: 1, mn: 1, mc: 1 }),
      row(A, "2026-11-21", { n: 1, c: 0, mn: 0, mc: 0 }),
    ]);
  });

  it("drops cohorts before cohortsFrom, exposures at/after asOf and unlisted variants", async () => {
    await expose("a1", A, 0); // 11-20
    await expose("a2", A, 24); // 11-21
    await expose("a3", A, 100); // at asOf
    await expose("x1", "zzzzzz", 30);
    expect(await run(eventGoal(), { cohortsFrom: "2026-11-21" })).toEqual([
      row(A, "2026-11-21", { n: 1, mn: 1 }),
    ]);
  });

  it("applies source and where filters", async () => {
    await expose("a1", A, 0);
    await expose("a2", A, 0);
    await expose("a3", A, 0);
    await event({ anon: "a1", hours: 1, source: "stripe", props: { plan: "pro", seats: 3 } });
    await event({ anon: "a2", hours: 1, source: "browser", props: { plan: "pro" } });
    await event({ anon: "a3", hours: 1, source: "stripe", props: { plan: "free" } });
    const goal = eventGoal({ source: "stripe", where: { plan: "pro" } });
    expect(await run(goal)).toEqual([row(A, "2026-11-20", { n: 3, c: 1, mn: 3, mc: 1 })]);
  });

  it("sums values per unit: event value, prop path and local-fn goal_values", async () => {
    await expose("a1", A, 0);
    await expose("a2", A, 0);
    await expose("a3", A, 0);
    // a1: 10 + 20 = 30; a2: 5; a3: converts without a value (counts, adds 0).
    await event({
      anon: "a1",
      hours: 1,
      value: 10,
      props: { order: { total: 10 } },
      goalValues: { goal: 1 },
    });
    await event({
      anon: "a1",
      hours: 2,
      value: 20,
      props: { order: { total: "20" } },
      goalValues: { goal: 2 },
    });
    await event({
      anon: "a2",
      hours: 1,
      value: 5,
      props: { order: { total: 5 } },
      goalValues: { goal: 4 },
    });
    await event({ anon: "a3", hours: 1, props: { order: { total: "n/a" } } });

    const byValue = { n: 3, c: 3, mn: 3, mc: 3 };
    expect(await run(eventGoal())).toEqual([
      row(A, "2026-11-20", { ...byValue, s1: 35, s2: 925, ms1: 35, ms2: 925 }),
    ]);
    expect(await run(eventGoal({ value: { kind: "prop", path: "order.total" } }))).toEqual([
      row(A, "2026-11-20", { ...byValue, s1: 35, s2: 925, ms1: 35, ms2: 925 }),
    ]);
    // goal_values: a1 = 3, a2 = 4 → s1 7, s2 25.
    expect(await run(eventGoal({ value: { kind: "local-fn" } }))).toEqual([
      row(A, "2026-11-20", { ...byValue, s1: 7, s2: 25, ms1: 7, ms2: 25 }),
    ]);
  });

  it("counts identified events from other devices and the server, once", async () => {
    await expose("a1", A, 0);
    await expose("a2", A, 0);
    await link("a1", "u1");
    await link("d2", "u1"); // u1's second device, never exposed
    await event({ anon: null, user: "u1", hours: 2, source: "server", value: 7 }); // server
    await event({ anon: "a1", user: "u1", hours: 3, value: 1 }); // same device, has both ids
    await event({ anon: "d2", user: "u1", hours: 4, value: 2 }); // other device
    expect(await run(eventGoal())).toEqual([
      row(A, "2026-11-20", { n: 2, c: 1, s1: 10, s2: 100, mn: 2, mc: 1, ms1: 10, ms2: 100 }),
    ]);
  });

  it("groups by segment (null = main)", async () => {
    await expose("a1", A, 0);
    await expose("a2", A, 0, "utm1");
    await event({ anon: "a2", hours: 1 });
    expect(await run(eventGoal())).toEqual([
      row(A, "2026-11-20", { n: 1, mn: 1 }),
      row(A, "2026-11-20", { n: 1, c: 1, mn: 1, mc: 1 }, "utm1"),
    ]);
  });

  it("returns no rows when nobody was exposed", async () => {
    expect(await run(eventGoal())).toEqual([]);
  });
});

describe("attribution (pageview goals)", () => {
  const pageview = (path: string): SerializedGoal => ({
    kind: "pageview",
    path,
    value: null,
    window: "1d",
    unit: "visitor",
    direction: "increase",
  });

  it("matches exact paths and trailing-* prefixes", async () => {
    await expose("a1", A, 0);
    await expose("a2", A, 0);
    await expose("a3", A, 0);
    await event({ name: "$pageview", anon: "a1", hours: 1, path: "/signup" });
    await event({ name: "$pageview", anon: "a2", hours: 1, path: "/signup/step-2" });
    await event({ name: "$pageview", anon: "a3", hours: 1, path: "/docs_x" });
    expect(await run(pageview("/signup"))).toEqual([
      row(A, "2026-11-20", { n: 3, c: 1, mn: 3, mc: 1 }),
    ]);
    expect(await run(pageview("/signup*"))).toEqual([
      row(A, "2026-11-20", { n: 3, c: 2, mn: 3, mc: 2 }),
    ]);
    // `_` and `%` in a prefix are literal characters, not LIKE wildcards.
    expect(await run(pageview("/docs%*"))).toEqual([row(A, "2026-11-20", { n: 3, mn: 3 })]);
  });
});

describe("attribution (user unit)", () => {
  it("one unit per identified user at the earliest exposure; any of their devices converts", async () => {
    await expose("a1", A, 0); // u1, device 1: unit u1 in A, cohort 11-20
    await expose("a2", B, 30); // u1, device 2: same user, ignored
    await expose("a3", B, 2); // u2
    await expose("a4", A, 2); // anonymous: not a user unit
    await link("a1", "u1");
    await link("a2", "u1");
    await link("a3", "u2");
    await event({ anon: "a2", hours: 5, value: 3 }); // u1 converts on device 2 (no user id on the event)
    await event({ anon: null, user: "u1", hours: 6, value: 4 }); // and on the server
    await event({ anon: "a4", hours: 3 });

    const goal = eventGoal({ unit: "user" });
    expect(await run(goal)).toEqual([
      row(A, "2026-11-20", { n: 1, c: 1, s1: 7, s2: 49, mn: 1, mc: 1, ms1: 7, ms2: 49 }),
      row(B, "2026-11-20", { n: 1, mn: 1 }),
    ]);
    // A user's cohort is the day of their earliest exposure, even when asking from a later day.
    expect(await run(goal, { cohortsFrom: "2026-11-21" })).toEqual([]);
  });
});
