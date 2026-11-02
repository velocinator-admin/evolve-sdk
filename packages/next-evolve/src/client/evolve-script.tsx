"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { flush, push, reportVitals, watchExposures, watchVitals } from "./beacon";

/**
 * Evolve beacon. Place once in the root layout. Not needed to show a variant.
 * Queues a page view and one exposure per counted region on every route, and
 * clicks/submits on `[data-evolve-goal]`; flushes every 2 s and on page hide.
 * Core Web Vitals (LCP, CLS, INP) go once per document, on the first hide.
 */
export function EvolveScript(): null {
  const path = usePathname();

  useEffect(() => {
    document.documentElement.dataset.evolve = "ready";
    watchVitals();
    const onGoal = (ev: Event) => {
      const el = (ev.target as Element | null)?.closest?.("[data-evolve-goal]");
      const n = el?.getAttribute("data-evolve-goal");
      // Forms count on submit only; other elements on click.
      if (!n || (ev.type === "submit") !== (el?.tagName === "FORM")) return;
      push({ t: "ev", n, p: location.pathname });
    };
    const send = () => {
      reportVitals();
      flush();
    };
    const onHide = () => document.visibilityState === "hidden" && send();
    document.addEventListener("click", onGoal, true);
    document.addEventListener("submit", onGoal, true);
    document.addEventListener("visibilitychange", onHide);
    addEventListener("pagehide", send);
    return () => {
      document.removeEventListener("click", onGoal, true);
      document.removeEventListener("submit", onGoal, true);
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("pagehide", send);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per route
  useEffect(() => {
    const p = location.pathname;
    push({ t: "pv", p });
    return watchExposures(p);
  }, [path]);

  return null;
}
