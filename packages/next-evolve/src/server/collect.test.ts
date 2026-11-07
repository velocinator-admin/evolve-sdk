import { beforeEach, describe, expect, it } from "vitest";
import { type FakeWriter, fakeWriter } from "../../test/fake-writer";
import { sampleBundle } from "../../test/samples";
import { defineConfig, resolveConfig } from "../config/config";
import { defineGoals } from "../config/goals";
import { createBotDetector } from "../core/bots";
import { createRefreshLimiter } from "../store/on-demand";
import { type CollectDeps, handleCollect } from "./collect";

const ANON = "AAAAAAAAAAAAAAAAAAAAAA";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const config = resolveConfig(
  defineConfig({ routes: { "/": { mode: "static" }, "/pricing": { mode: "static" } } }),
);
const goals = defineGoals({
  signup_page: { pageview: "/signup" },
  paid: { event: "purchase", value: (e) => Number(e.props.amount) * 2 },
});

let w: FakeWriter;
let deps: CollectDeps;
beforeEach(() => {
  w = fakeWriter();
  deps = {
    config,
    goals,
    bundle: () => sampleBundle(),
    isBot: createBotDetector([]),
    writer: w,
    now: () => new Date("2026-10-31T12:00:00Z"),
  };
});

function req(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://acme.test/api/evolve/collect", {
    method: "POST",
    body: text,
    headers: {
      host: "acme.test",
      origin: "https://acme.test",
      "user-agent": UA,
      cookie: `evolve_id=${ANON}`,
      "content-type": "text/plain",
      ...headers,
    },
  });
}

describe("collect", () => {
  it("stores known exposures, tested page views, goal page views, events and identities", async () => {
    const status = await handleCollect(
      req({
        v: 1,
        events: [
          { t: "pv", p: "/" },
          { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
          { t: "exp", e: "k3j9x2", v: "zzzzzz", p: "/" }, // not in the bundle
          { t: "exp", e: "p7q8r9", v: "c1d2e3", p: "/" }, // variant of another experiment
          { t: "pv", p: "/signup" },
          { t: "pv", p: "/features" },
          { t: "ev", n: "purchase", p: "/pricing", props: { amount: 10 } },
          { t: "id", u: "user_1" },
          { t: "nope" },
        ],
      }),
      deps,
    );
    expect(status).toBe(204);
    expect(w.rows.exposures).toEqual([
      {
        experiment_id: "k3j9x2",
        anon_id: ANON,
        variant_id: "c1d2e3",
        path: "/",
        first_at: new Date("2026-10-31T12:00:00Z"),
      },
    ]);
    expect(w.rows.usage).toEqual(new Map([["2026-10-31", 1]]));
    expect(w.rows.events.map((e) => [e.name, e.path, e.source, e.anon_id])).toEqual([
      ["$pageview", "/signup", "browser", ANON],
      ["purchase", "/pricing", "browser", ANON],
    ]);
    expect(w.rows.events[1]?.goal_values).toEqual({ paid: 20 });
    expect(w.rows.identities).toEqual([{ anon_id: ANON, user_id: "user_1" }]);
  });

  it("re-reads the bundle when a beacon names an experiment this instance doesn't know yet", async () => {
    // A cold serverless instance (no bundle yet) or one that hasn't polled since a
    // start: without a refresh it would drop the exposure the proxy just assigned.
    let current: ReturnType<typeof sampleBundle> | null = null;
    let refreshes = 0;
    deps.bundle = () => current;
    deps.refreshBundle = async () => {
      refreshes++;
      current = sampleBundle();
    };
    await handleCollect(
      req({
        v: 1,
        events: [
          { t: "pv", p: "/" },
          { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
        ],
      }),
      deps,
    );
    expect(refreshes).toBe(1);
    expect(w.rows.exposures.map((e) => e.variant_id)).toEqual(["c1d2e3"]);
    expect(w.rows.usage.get("2026-10-31")).toBe(1);

    // Known pairs (and batches without exposures) don't refresh.
    await handleCollect(
      req({ v: 1, events: [{ t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" }] }),
      deps,
    );
    await handleCollect(
      req({ v: 1, events: [{ t: "ev", n: "purchase", props: { amount: 1 } }] }),
      deps,
    );
    expect(refreshes).toBe(1);
  });

  // T19.5 drill: stale instances dropped real visits' exposures and vitals.
  it("a refresh that predates the publish isn't the last word: one more round, then counted", async () => {
    let calls = 0;
    let current = sampleBundle((b) => {
      b.ver = 2;
      delete b.routing.experiments.k3j9x2;
    });
    deps.bundle = () => current;
    deps.refreshBundle = async () => {
      calls++;
      if (calls === 2) current = sampleBundle(); // the shared fetch was older; this one is new
    };
    await handleCollect(
      req({
        v: 1,
        events: [
          { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
          { t: "cwv", m: "lcp", v: 1850, p: "/" },
        ],
      }),
      deps,
    );
    expect(calls).toBe(2);
    expect(w.rows.exposures.map((e) => e.variant_id)).toEqual(["c1d2e3"]);
    expect(w.rows.vitals.map((v) => [v.variant_id, v.metric])).toEqual([["c1d2e3", "lcp"]]);
  });

  it("concurrent beacons for a pair the instance doesn't know all wait for the same refresh", async () => {
    let current: ReturnType<typeof sampleBundle> | null = null;
    let fetches = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const limiter = createRefreshLimiter(async () => {
      fetches++;
      await gate;
      current = sampleBundle();
    });
    deps.bundle = () => current;
    deps.refreshBundle = limiter.soon;
    const beacon = (v: number) =>
      handleCollect(
        req({
          v: 1,
          events: [
            { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
            { t: "cwv", m: "lcp", v, p: "/" },
          ],
        }),
        deps,
      );
    const all = Promise.all([beacon(400), beacon(500), beacon(600)]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await all).toEqual([204, 204, 204]);
    expect(fetches).toBe(1);
    expect(w.rows.exposures).toHaveLength(3);
    expect(w.rows.vitals).toHaveLength(3);
  });

  // T31.1: a held beacon holds a browser connection (6 per host on HTTP/1.1), so
  // after a pause a returning visitor's reloads stalled until the refresh cap.
  it("answers the beacon before waiting for a refresh, then records once it's done", async () => {
    let current: ReturnType<typeof sampleBundle> | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    deps.bundle = () => current;
    deps.refreshBundle = async () => {
      await gate;
      current = sampleBundle();
    };
    const deferred: Promise<void>[] = [];
    deps.defer = (task) => {
      deferred.push(task());
      return true;
    };
    const status = await Promise.race([
      handleCollect(
        req({
          v: 1,
          events: [
            { t: "pv", p: "/" },
            { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
          ],
        }),
        deps,
      ),
      new Promise((r) => setTimeout(() => r("held"), 200)),
    ]);
    expect(status).toBe(204);
    expect(deferred).toHaveLength(1);
    expect(w.rows.exposures).toEqual([]);
    release();
    await Promise.all(deferred);
    expect(w.rows.exposures.map((e) => e.variant_id)).toEqual(["c1d2e3"]);
    expect(w.rows.usage.get("2026-10-31")).toBe(1);

    // Nothing to wait for: recorded inline, nothing deferred.
    await handleCollect(
      req({ v: 1, events: [{ t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" }] }),
      deps,
    );
    expect(deferred).toHaveLength(1);
    expect(w.rows.exposures).toHaveLength(2);

    // Can't defer (outside a request): waits, then answers.
    current = null;
    deps.defer = () => false;
    await handleCollect(
      req({ v: 1, events: [{ t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" }] }),
      deps,
    );
    expect(w.rows.exposures).toHaveLength(3);
  });

  it("forged pairs: at most two refresh rounds, then dropped; a hanging refresh is capped", async () => {
    let calls = 0;
    deps.refreshBundle = async () => {
      calls++;
    };
    await handleCollect(
      req({ v: 1, events: [{ t: "exp", e: "zzzzzz", v: "yyyyyy", p: "/" }] }),
      deps,
    );
    expect(calls).toBe(2);
    expect(w.rows.exposures).toEqual([]);

    deps.refreshBundle = () => new Promise<void>(() => {});
    deps.refreshCapMs = 30;
    const started = Date.now();
    expect(
      await handleCollect(
        req({ v: 1, events: [{ t: "exp", e: "zzzzzz", v: "yyyyyy", p: "/" }] }),
        deps,
      ),
    ).toBe(204);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("counts page views on a running experiment's route only", async () => {
    await handleCollect(
      req({
        v: 1,
        events: [
          { t: "pv", p: "/pricing/" },
          { t: "pv", p: "/" },
        ],
      }),
      deps,
    );
    expect(w.rows.usage.get("2026-10-31")).toBe(2);
    deps.bundle = () => null;
    w.rows.usage.clear();
    await handleCollect(req({ v: 1, events: [{ t: "pv", p: "/" }] }), deps);
    expect(w.rows.usage.size).toBe(0);
  });

  it("drops the batch for bots, preview sessions, missing ids and no consent", async () => {
    const batch = { v: 1, events: [{ t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" }] };
    expect(await handleCollect(req(batch, { "user-agent": "Googlebot/2.1" }), deps)).toBe(204);
    expect(
      await handleCollect(req(batch, { cookie: `evolve_id=${ANON}; evolve_pv=tok` }), deps),
    ).toBe(204);
    expect(await handleCollect(req(batch, { cookie: "" }), deps)).toBe(204);
    expect(await handleCollect(req(batch, { cookie: "evolve_id=short" }), deps)).toBe(204);
    const noConsent = resolveConfig(defineConfig({ routes: {}, consent: () => false }));
    expect(await handleCollect(req(batch), { ...deps, config: noConsent })).toBe(204);
    expect(w.rows.exposures).toEqual([]);
  });

  it("rejects cross-origin, oversized and malformed batches", async () => {
    const ok = { v: 1, events: [] };
    expect(await handleCollect(req(ok, { origin: "https://evil.test" }), deps)).toBe(403);
    const noOrigin = req(ok, { origin: "" });
    expect(await handleCollect(noOrigin, deps)).toBe(403);
    expect(
      await handleCollect(req(ok, { origin: "", "sec-fetch-site": "same-origin" }), deps),
    ).toBe(204);
    expect(await handleCollect(req("x".repeat(33 * 1024)), deps)).toBe(413);
    const many = { v: 1, events: Array.from({ length: 51 }, () => ({ t: "pv", p: "/" })) };
    expect(await handleCollect(req(many), deps)).toBe(400);
    expect(await handleCollect(req("{not json"), deps)).toBe(400);
    expect(await handleCollect(req({ v: 2, events: [] }), deps)).toBe(400);
  });

  it("drops props over 2 KB but keeps the event", async () => {
    const props = { blob: "x".repeat(3000) };
    await handleCollect(req({ v: 1, events: [{ t: "ev", n: "cta_click", props }] }), deps);
    expect(w.rows.events).toHaveLength(1);
    expect(w.rows.events[0]?.props).toBeNull();
  });
});

describe("collect: Core Web Vitals (protocol 1.1.0)", () => {
  const exp = (e: string, v: string, p = "/") => ({ t: "exp", e, v, p });
  const cwv = (m: string, v: unknown, p = "/") => ({ t: "cwv", m, v, p });
  const vitals = () =>
    w.rows.vitals.map((r) => `${r.experiment_id}:${r.variant_id}:${r.metric}:${r.day}:${r.bin}`);

  it("bins each metric for every counted pair the batch reports on that page", async () => {
    await handleCollect(
      req({
        v: 1,
        events: [
          exp("k3j9x2", "c1d2e3", "/pricing"),
          exp("p7q8r9", "s4t5u6", "/pricing"),
          cwv("lcp", 1200, "/pricing"),
          cwv("cls", 0.12, "/pricing"),
          cwv("inp", 180, "/pricing"),
        ],
      }),
      deps,
    );
    expect(vitals()).toEqual([
      "k3j9x2:c1d2e3:lcp:2026-10-31:4",
      "p7q8r9:s4t5u6:lcp:2026-10-31:4",
      "k3j9x2:c1d2e3:cls:2026-10-31:6",
      "p7q8r9:s4t5u6:cls:2026-10-31:6",
      "k3j9x2:c1d2e3:inp:2026-10-31:9",
      "p7q8r9:s4t5u6:inp:2026-10-31:9",
    ]);
    expect(w.rows.vitals.every((r) => r.count === 1)).toBe(true);
    // Counts only: no visitor id travels with vitals.
    expect(Object.keys(w.rows.vitals[0]!).sort()).toEqual(
      ["bin", "count", "day", "experiment_id", "metric", "variant_id"].sort(),
    );
  });

  it("ignores vitals without a known counted pair on the same page", async () => {
    await handleCollect(
      req({
        v: 1,
        events: [
          exp("k3j9x2", "zzzzzz"), // not in the bundle
          exp("p7q8r9", "c1d2e3"), // variant of another experiment
          exp("k3j9x2", "c1d2e3", "/pricing"), // another page
          cwv("lcp", 900),
        ],
      }),
      deps,
    );
    expect(vitals()).toEqual([]);
    await handleCollect(req({ v: 1, events: [cwv("lcp", 900)] }), deps);
    expect(vitals()).toEqual([]);
  });

  it("drops out-of-range and malformed values, unknown metrics and repeats", async () => {
    await handleCollect(
      req({
        v: 1,
        events: [
          exp("k3j9x2", "a8f2l1"),
          cwv("lcp", -1),
          cwv("lcp", 600_001),
          cwv("inp", "100"),
          cwv("cls", 10.5),
          cwv("fcp", 100),
          cwv("inp", 600_000),
          cwv("inp", 40), // second INP for the page: ignored
          cwv("cls", 0),
        ],
      }),
      deps,
    );
    expect(vitals()).toEqual(["k3j9x2:a8f2l1:inp:2026-10-31:20", "k3j9x2:a8f2l1:cls:2026-10-31:0"]);
  });

  it("stores nothing for bots, preview sessions and visitors without an id", async () => {
    const batch = { v: 1, events: [exp("k3j9x2", "c1d2e3"), cwv("lcp", 1000)] };
    await handleCollect(req(batch, { "user-agent": "Googlebot/2.1" }), deps);
    await handleCollect(req(batch, { cookie: `evolve_id=${ANON}; evolve_pv=tok` }), deps);
    await handleCollect(req(batch, { cookie: "" }), deps);
    expect(vitals()).toEqual([]);
  });
});

describe("collect with UTM rules (D76)", () => {
  const ruled = () =>
    sampleBundle((b) => {
      b.rules = [
        {
          id: "r1s2t3",
          exp: "k3j9x2",
          var: "c1d2e3",
          when: [{ f: "utm_campaign", op: "eq", v: "spring-sale" }],
        },
      ];
    });

  it("an exposure of the session rule's variant gets segment = rule id and no vitals", async () => {
    deps.bundle = ruled;
    const status = await handleCollect(
      req(
        {
          v: 1,
          events: [
            { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
            { t: "cwv", m: "lcp", v: 1200, p: "/" },
          ],
        },
        { cookie: `evolve_id=${ANON}; evolve_r=k3j9x2:r1s2t3` },
      ),
      deps,
    );
    expect(status).toBe(204);
    expect(w.rows.exposures).toMatchObject([{ variant_id: "c1d2e3", segment: "r1s2t3" }]);
    expect(w.rows.vitals).toEqual([]);
  });

  it("without evolve_r, or for another variant, the exposure is main", async () => {
    deps.bundle = ruled;
    await handleCollect(
      req({ v: 1, events: [{ t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" }] }),
      deps,
    );
    await handleCollect(
      req(
        { v: 1, events: [{ t: "exp", e: "k3j9x2", v: "a8f2l1", p: "/" }] },
        { cookie: `evolve_id=${ANON}; evolve_r=k3j9x2:r1s2t3` },
      ),
      deps,
    );
    expect(w.rows.exposures.map((r) => r.segment)).toEqual([undefined, undefined]);
  });
});
