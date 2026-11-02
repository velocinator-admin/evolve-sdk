import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _reset,
  COLLECT_URL,
  flush,
  identify,
  push,
  reportVitals,
  track,
  watchExposures,
  watchVitals,
} from "./beacon";

let sent: { url: string; body: unknown }[];
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { pathname: "/pricing" });
  vi.stubGlobal("navigator", {
    webdriver: false,
    sendBeacon: (url: string, body: string) => {
      sent.push({ url, body: JSON.parse(body) });
      return true;
    },
  });
  _reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("beacon queue", () => {
  it("batches events and flushes after 2 s to the same-origin collect route", () => {
    push({ t: "pv", p: "/pricing" });
    track("cta_click", { plan: "pro" });
    identify("u_1");
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([
      {
        url: COLLECT_URL,
        body: {
          v: 1,
          events: [
            { t: "pv", p: "/pricing" },
            { t: "ev", n: "cta_click", p: "/pricing", props: { plan: "pro" } },
            { t: "id", u: "u_1" },
          ],
        },
      },
    ]);
  });

  it("sends at most 50 events per request", () => {
    for (let i = 0; i < 120; i++) push({ t: "pv", p: "/" });
    flush();
    expect(sent.map((s) => (s.body as { events: unknown[] }).events.length)).toEqual([50, 50, 20]);
  });

  it("falls back to fetch(keepalive) when sendBeacon refuses", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { webdriver: false, sendBeacon: () => false });
    push({ t: "pv", p: "/" });
    flush();
    expect(fetchMock).toHaveBeenCalledWith(
      COLLECT_URL,
      expect.objectContaining({ keepalive: true }),
    );
  });

  it("does nothing under automation (navigator.webdriver)", () => {
    vi.stubGlobal("navigator", { webdriver: true, sendBeacon: () => true });
    push({ t: "pv", p: "/" });
    flush();
    expect(sent).toEqual([]);
  });
});

describe("watchExposures", () => {
  type El = { getAttribute: (n: string) => string | null };
  const region = (e: string, v: string): El => ({
    getAttribute: (n) => (n === "data-evolve-e" ? e : n === "data-evolve-v" ? v : null),
  });
  let dom: El[];
  beforeEach(() => {
    dom = [];
    vi.stubGlobal("document", { querySelectorAll: () => dom });
  });
  const exposures = () =>
    sent
      .flatMap((s) => (s.body as { events: { t: string; e?: string }[] }).events)
      .filter((e) => e.t === "exp");

  it("counts regions that stream in after the first scan (Suspense), once each", () => {
    dom = [region("exp001", "var001")];
    const stop = watchExposures("/");
    dom = [region("exp001", "var001"), region("exp002", "var002")]; // streamed in later
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(3000);
    flush();
    expect(exposures()).toEqual([
      { t: "exp", e: "exp001", v: "var001", p: "/" },
      { t: "exp", e: "exp002", v: "var002", p: "/" },
    ]);
    stop();
  });

  it("stops looking after a route change", () => {
    const stop = watchExposures("/");
    stop();
    dom = [region("exp003", "var003")];
    vi.advanceTimersByTime(5000);
    flush();
    expect(exposures()).toEqual([]);
  });
});

describe("Core Web Vitals", () => {
  type Entry = Record<string, unknown>;
  let observers: Map<string, (entries: Entry[]) => void>;
  let listeners: Map<string, () => void>;
  let supported: string[];
  let dom: { getAttribute: (n: string) => string | null }[];

  class FakeObserver {
    static get supportedEntryTypes() {
      return supported;
    }
    constructor(private cb: (list: { getEntries: () => Entry[] }) => void) {}
    observe(o: { type: string; buffered?: boolean; durationThreshold?: number }) {
      if (!supported.includes(o.type)) throw new TypeError("unsupported");
      this.type = o.type;
      observers.set(o.type, (entries) => this.cb({ getEntries: () => entries }));
    }
    private type = "";
    takeRecords(): Entry[] {
      return queued.get(this.type)?.splice(0) ?? [];
    }
    disconnect() {}
  }
  let queued: Map<string, Entry[]>;
  const emit = (type: string, ...entries: Entry[]) => observers.get(type)?.(entries);
  const region = (e: string, v: string) => ({
    getAttribute: (n: string) => (n === "data-evolve-e" ? e : n === "data-evolve-v" ? v : null),
  });
  const events = () => sent.flatMap((s) => (s.body as { events: Entry[] }).events);

  beforeEach(() => {
    observers = new Map();
    queued = new Map();
    listeners = new Map();
    supported = ["largest-contentful-paint", "layout-shift", "event", "first-input"];
    dom = [region("k3j9x2", "c1d2e3")];
    vi.stubGlobal("PerformanceObserver", FakeObserver);
    vi.stubGlobal("document", { querySelectorAll: () => dom });
    vi.stubGlobal("addEventListener", (t: string, f: () => void) => listeners.set(t, f));
  });

  it("sends LCP, CLS and INP once, with the page's counted pairs, when reported", () => {
    watchExposures("/");
    flush();
    sent = [];
    watchVitals();
    emit("largest-contentful-paint", { startTime: 800 }, { startTime: 1450 });
    emit("layout-shift", { startTime: 100, value: 0.05, hadRecentInput: false });
    emit("layout-shift", { startTime: 600, value: 0.04, hadRecentInput: false });
    emit("layout-shift", { startTime: 900, value: 0.5, hadRecentInput: true }); // after input: ignored
    emit("layout-shift", { startTime: 3000, value: 0.02, hadRecentInput: false }); // new window
    emit("first-input", { duration: 24, interactionId: 7 });
    emit("event", { duration: 96, interactionId: 8 }, { duration: 300, interactionId: 0 });
    reportVitals();
    flush();
    expect(events()).toEqual([
      { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
      { t: "cwv", m: "lcp", v: 1450, p: "/" },
      { t: "cwv", m: "cls", v: 0.09, p: "/" },
      { t: "cwv", m: "inp", v: 96, p: "/" },
    ]);
    sent = [];
    reportVitals(); // once per page view
    flush();
    expect(events()).toEqual([]);
  });

  it("takes entries the observer still holds when the page hides", () => {
    watchExposures("/");
    watchVitals();
    emit("largest-contentful-paint", { startTime: 640 });
    queued.set("event", [{ duration: 72, interactionId: 3, startTime: 900 }]); // a click right before hide
    reportVitals();
    flush();
    expect(events().find((e) => e.m === "inp")?.v).toBe(72);
  });

  it("keeps the LCP from before the first input", () => {
    watchExposures("/");
    watchVitals();
    emit("largest-contentful-paint", { startTime: 700 });
    listeners.get("pointerdown")?.();
    emit("largest-contentful-paint", { startTime: 2600 });
    reportVitals();
    flush();
    // No layout shift observed: CLS is 0, not missing.
    expect(events().filter((e) => e.t === "cwv")).toEqual([
      { t: "cwv", m: "lcp", v: 700, p: "/" },
      { t: "cwv", m: "cls", v: 0, p: "/" },
    ]);
  });

  it("caps a CLS session window at 5 s and keeps the largest window", () => {
    watchExposures("/");
    watchVitals();
    // A shift every 900 ms (gaps < 1 s) for 6.3 s: the window closes at 5 s.
    for (let t = 0; t <= 6300; t += 900)
      emit("layout-shift", { startTime: t, value: 0.01, hadRecentInput: false });
    reportVitals();
    flush();
    const cls = events().find((e) => e.m === "cls");
    expect(cls?.v).toBeCloseTo(0.06, 10);
  });

  it("sends the first page's vitals after a client-side navigation", () => {
    const stop = watchExposures("/");
    watchVitals();
    emit("largest-contentful-paint", { startTime: 500 });
    stop();
    dom = [region("p7q8r9", "s4t5u6")];
    watchExposures("/pricing");
    reportVitals();
    flush();
    expect(events().slice(-3)).toEqual([
      { t: "exp", e: "k3j9x2", v: "c1d2e3", p: "/" },
      { t: "cwv", m: "lcp", v: 500, p: "/" },
      { t: "cwv", m: "cls", v: 0, p: "/" },
    ]);
  });

  it("sends nothing without a counted region, without measurements or under automation", () => {
    dom = [];
    watchExposures("/");
    watchVitals();
    emit("largest-contentful-paint", { startTime: 500 });
    reportVitals();
    flush();
    expect(events().filter((e) => e.t === "cwv")).toEqual([]);

    _reset();
    dom = [region("k3j9x2", "c1d2e3")];
    supported = []; // browser without these entry types
    watchExposures("/");
    watchVitals();
    reportVitals();
    flush();
    expect(events().filter((e) => e.t === "cwv")).toEqual([]);

    _reset();
    sent = [];
    supported = ["largest-contentful-paint"];
    vi.stubGlobal("navigator", { webdriver: true, sendBeacon: () => true });
    watchExposures("/");
    watchVitals();
    emit("largest-contentful-paint", { startTime: 500 });
    reportVitals();
    flush();
    expect(sent).toEqual([]);
  });
});
