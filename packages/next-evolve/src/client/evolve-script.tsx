"use client";

import { useEffect } from "react";

/**
 * Evolve beacon. Place once in the root layout.
 * Phase 1 stub: marks the document as hydrated. The real beacon (exposures,
 * page views, goal clicks) lands in T5.1.
 */
export function EvolveScript(): null {
  useEffect(() => {
    document.documentElement.dataset.evolve = "ready";
  }, []);
  return null;
}
