---
"next-evolve": minor
---

The beacon measures Core Web Vitals with hand-written `PerformanceObserver`s (no new dependency): LCP (last candidate before the first input), CLS (largest session window) and INP (approximated as the longest interaction on the page, good enough to compare arms on the same page). It sends them once per document, on the first page hide, together with that page's counted experiment/variant pairs, to the same-origin collect route. No new id is sent. Skipped for browsers without these entry types and under automation (`navigator.webdriver`); the collect route drops bots and previews. The client budget is now 3 KB gzipped (the beacon is about 2.6 KB).
