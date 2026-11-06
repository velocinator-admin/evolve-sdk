// T19.7 soak: the simulator's pacing, guardrail event and early stop, against
// a fake fixture (no network). The e2e (m5.spec.ts) covers a real fixture.
import { describe, expect, it } from "vitest";
import { parseArgs, simulate } from "./simulate";

const EXP = "k3j9x2";
const CTRL = "aaaaaa";
const B = "bbbbbb";

/** A fake fixture: alternates arms, records every collect body. */
function fakeFixture(opts: { status?: number } = {}) {
  let i = 0;
  const calls: { url: string; at: number; body?: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, at: Date.now(), body: init?.body as string | undefined });
    if (u.endsWith("/api/evolve/collect")) return new Response(null, { status: 204 });
    if (opts.status) return new Response("challenge", { status: opts.status });
    const arm = i++ % 2 === 0 ? CTRL : B;
    const headers = new Headers();
    headers.append("set-cookie", `evolve_id=anon${i}xxxxxxxxxxxxxxxxx; Path=/`);
    headers.append("set-cookie", `evolve_a=${EXP}:${arm}; Path=/`);
    return new Response("<html></html>", { status: 200, headers });
  }) as typeof fetch;
  const events = (name: string) =>
    calls
      .filter((c) => c.body)
      .flatMap((c) => JSON.parse(c.body!).events as { t: string; n?: string }[])
      .filter((e) => e.t === "ev" && e.n === name).length;
  return { f, calls, events };
}

describe("simulate (T19.7 soak options)", () => {
  it("sends a guardrail event per arm rate, independent of the primary", async () => {
    const fx = fakeFixture();
    const r = await simulate({
      url: "https://fixture.test",
      visitors: 40,
      goal: "pricing_cta",
      rate: 0,
      guardrail: "cta_click",
      guardrailRate: 0,
      guardrailRates: { [B]: 1 },
      seed: 1,
      concurrency: 1,
      fetch: fx.f,
    });
    expect(r.errors).toBe(0);
    expect(r.arms[`${EXP}:${CTRL}`]).toEqual({ n: 20, c: 0, g: 0 });
    expect(r.arms[`${EXP}:${B}`]).toEqual({ n: 20, c: 0, g: 20 });
    expect(fx.events("cta_click")).toBe(20);
    expect(fx.events("pricing_cta")).toBe(0);
  });

  it("paces every request to at most `rps` per second", async () => {
    const fx = fakeFixture();
    await simulate({
      url: "https://fixture.test",
      visitors: 5,
      goal: "g",
      rate: 0,
      rps: 40, // 25 ms apart
      concurrency: 4,
      fetch: fx.f,
    });
    expect(fx.calls).toHaveLength(10); // a page and a collect per visitor
    const gaps = fx.calls.slice(1).map((c, i) => c.at - fx.calls[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20);
  });

  it("stops after `stopAfterErrors` errors in a row (e.g. a host's bot challenge)", async () => {
    const fx = fakeFixture({ status: 403 });
    const r = await simulate({
      url: "https://fixture.test",
      visitors: 100,
      goal: "g",
      rate: 0,
      stopAfterErrors: 5,
      concurrency: 1,
      fetch: fx.f,
    });
    expect(r.errors).toBe(5);
    expect(r.stopped).toBe(true);
    expect(fx.calls).toHaveLength(5);
    expect(r.errorReasons).toEqual({ "page 403 without an evolve_id cookie": 5 });
  });

  it("parses the soak flags", () => {
    const o = parseArgs([
      "--rps",
      "0.25",
      "--guardrail",
      "cta_click",
      "--guardrail-rate",
      "0.3",
      "--guardrail-rate",
      `${B}=0.02`,
      "--stop-after-errors",
      "10",
      "--rate",
      `${CTRL}=0.2`,
    ]);
    expect(o).toMatchObject({
      rps: 0.25,
      guardrail: "cta_click",
      guardrailRate: 0.3,
      guardrailRates: { [B]: 0.02 },
      stopAfterErrors: 10,
      rates: { [CTRL]: 0.2 },
    });
  });
});
