import { beforeEach, describe, expect, it } from "vitest";
import { type FakeWriter, fakeWriter } from "../../test/fake-writer";
import { sampleBundle } from "../../test/samples";
import { defineConfig, resolveConfig } from "../config/config";
import { defineGoals } from "../config/goals";
import { createBotDetector } from "../core/bots";
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
