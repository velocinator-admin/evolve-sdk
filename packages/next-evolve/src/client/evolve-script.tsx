"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { flush, push } from "./beacon";

/**
 * Evolve beacon. Place once in the root layout. Not needed to show a variant.
 * Queues a page view and one exposure per counted region on every route, and
 * clicks/submits on `[data-evolve-goal]`; flushes every 2 s and on page hide.
 */
export function EvolveScript(): null {
  const path = usePathname();

  useEffect(() => {
    document.documentElement.dataset.evolve = "ready";
    const onGoal = (ev: Event) => {
      const el = (ev.target as Element | null)?.closest?.("[data-evolve-goal]");
      const n = el?.getAttribute("data-evolve-goal");
      // Forms count on submit only; other elements on click.
      if (!n || (ev.type === "submit") !== (el?.tagName === "FORM")) return;
      push({ t: "ev", n, p: location.pathname });
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("click", onGoal, true);
    document.addEventListener("submit", onGoal, true);
    document.addEventListener("visibilitychange", onHide);
    addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("click", onGoal, true);
      document.removeEventListener("submit", onGoal, true);
      document.removeEventListener("visibilitychange", onHide);
      removeEventListener("pagehide", flush);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per route
  useEffect(() => {
    const p = location.pathname;
    push({ t: "pv", p });
    const seen = new Set<string>();
    for (const el of document.querySelectorAll("[data-evolve-e]:not([data-evolve-x])")) {
      const e = el.getAttribute("data-evolve-e");
      const v = el.getAttribute("data-evolve-v");
      if (e && v && !seen.has(e)) {
        seen.add(e);
        push({ t: "exp", e, v, p });
      }
    }
  }, [path]);

  return null;
}
