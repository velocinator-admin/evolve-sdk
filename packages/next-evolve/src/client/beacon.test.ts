import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _reset, COLLECT_URL, flush, identify, push, track, watchExposures } from "./beacon";

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
