// Browser event queue for the Evolve beacon (spec §5.9). Same-origin only;
// nothing goes to a third party. Kept tiny: the client budget is 3 KB gz.

type BeaconEvent = Record<string, unknown>;
/** The fields read from LCP, layout-shift, first-input and event entries. */
type Entry = PerformanceEntry & { value: number; hadRecentInput: boolean; interactionId?: number };

export const COLLECT_URL = "/api/evolve/collect";
const MAX = 50;
let queue: BeaconEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
/** The document's first page and the counted pairs seen on it (vitals are measured per document). */
let page: { p: string; pairs: Map<string, BeaconEvent> } | undefined;
/** Vitals measured so far, until reported; undefined before `watchVitals` and after the report. */
let vitals: Record<string, number> | undefined;
/** Delivers entries the observers haven't handed over yet (an interaction just before hide). */
let pending: (() => void)[] = [];

/** Off on the server and under automation (`navigator.webdriver`). */
const off = (): boolean => typeof window === "undefined" || !!navigator.webdriver;

export function push(e: BeaconEvent): void {
  if (off()) return;
  queue.push(e);
  if (queue.length >= MAX) flush();
  else timer ??= setTimeout(flush, 2000);
}

export function flush(): void {
  clearTimeout(timer);
  timer = undefined;
  while (queue.length) {
    const body = JSON.stringify({ v: 1, events: queue.splice(0, MAX) });
    if (!navigator.sendBeacon?.(COLLECT_URL, body)) {
      fetch(COLLECT_URL, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  }
}

/**
 * Queues one exposure per counted region (`[data-evolve-e]` without
 * `data-evolve-x`) on this page, now and again after 1 s and 4 s: regions
 * inside <Suspense> (dynamic mode, cacheComponents) can stream in after the
 * page's first effect. Returns the cleanup for a route change.
 */
export function watchExposures(p: string): () => void {
  const seen = new Set<string>();
  page ??= { p, pairs: new Map() };
  const first = page.p === p ? page.pairs : undefined;
  const scan = () => {
    for (const el of document.querySelectorAll("[data-evolve-e]:not([data-evolve-x])")) {
      const e = el.getAttribute("data-evolve-e");
      const v = el.getAttribute("data-evolve-v");
      if (e && v && !seen.has(e)) {
        seen.add(e);
        const x = { t: "exp", e, v, p };
        if (!first?.has(e)) first?.set(e, x);
        push(x);
      }
    }
  };
  scan();
  const timers = [1000, 4000].map((ms) => setTimeout(scan, ms));
  return () => timers.forEach(clearTimeout);
}

/**
 * Measures Core Web Vitals for this document (spec §9.4) with hand-written
 * observers: LCP (last candidate before the first input), CLS (largest session
 * window: gaps < 1 s, ≤ 5 s, shifts after input ignored) and INP approximated
 * as the longest interaction. Entry types the browser lacks are skipped.
 */
export function watchVitals(): void {
  if (off() || vitals) return;
  const v: Record<string, number> = {};
  vitals = v;
  const max = (m: string, x: number) => {
    v[m] = Math.max(v[m] ?? 0, x);
  };
  const observe = (type: string, cb: (e: Entry) => void): boolean => {
    try {
      const o = new PerformanceObserver((l) => (l.getEntries() as Entry[]).forEach(cb));
      o.observe({ type, buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
      pending.push(() => (o.takeRecords() as Entry[]).forEach(cb));
      return true;
    } catch {
      return false;
    }
  };
  let lcpOpen = true;
  const stopLcp = () => {
    lcpOpen = false;
  };
  for (const t of ["keydown", "pointerdown"])
    addEventListener(t, stopLcp, { once: true, capture: true });
  observe("largest-contentful-paint", (e) => {
    if (lcpOpen) v.lcp = Math.round(e.startTime);
  });
  let sum = 0;
  let start = 0;
  let last = -1e9;
  // No shift at all is a CLS of 0 (when the browser reports shifts).
  if (
    observe("layout-shift", (e) => {
      if (e.hadRecentInput) return;
      if (e.startTime - last < 1000 && e.startTime - start < 5000) sum += e.value;
      else {
        sum = e.value;
        start = e.startTime;
      }
      last = e.startTime;
      max("cls", Math.round(sum * 1e4) / 1e4);
    })
  )
    max("cls", 0);
  observe("first-input", (e) => max("inp", e.duration));
  observe("event", (e) => e.interactionId && max("inp", e.duration));
}

/**
 * Queues the vitals once per document, with the first page's counted pairs so
 * the collect route can attribute them (no new id). Call before `flush` on hide.
 */
export function reportVitals(): void {
  for (const take of pending) take();
  const v = vitals;
  if (!v || !page) return;
  const ms = ["lcp", "cls", "inp"].filter((m) => m in v);
  if (!page.pairs.size || !ms.length) return;
  vitals = {}; // keep observers quiet; nothing more is sent for this document
  const p = page.p;
  for (const x of page.pairs.values()) push(x);
  for (const m of ms) push({ t: "cwv", m, v: v[m], p });
  page.pairs.clear();
}

/** Records a browser event (e.g. `track("cta_click", { plan: "pro" })`). */
export function track(name: string, props?: Record<string, unknown>): void {
  push({ t: "ev", n: name, p: location.pathname, ...(props ? { props } : {}) });
}

/** Links this visitor to your user id. Prefer `evolve.identify()` on the server. */
export function identify(userId: string): void {
  push({ t: "id", u: String(userId) });
}

/** Test helper. */
export function _reset(): void {
  clearTimeout(timer);
  timer = undefined;
  queue = [];
  page = vitals = undefined;
  pending = [];
}
