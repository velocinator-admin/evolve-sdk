// Browser event queue for the Evolve beacon (spec §5.9). Same-origin only;
// nothing goes to a third party. Kept tiny: the client budget is 2 KB gz.

type BeaconEvent = Record<string, unknown>;

export const COLLECT_URL = "/api/evolve/collect";
const MAX = 50;
let queue: BeaconEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

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
  const scan = () => {
    for (const el of document.querySelectorAll("[data-evolve-e]:not([data-evolve-x])")) {
      const e = el.getAttribute("data-evolve-e");
      const v = el.getAttribute("data-evolve-v");
      if (e && v && !seen.has(e)) {
        seen.add(e);
        push({ t: "exp", e, v, p });
      }
    }
  };
  scan();
  const timers = [1000, 4000].map((ms) => setTimeout(scan, ms));
  return () => timers.forEach(clearTimeout);
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
}
