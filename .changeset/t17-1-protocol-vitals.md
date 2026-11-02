---
"@next-evolve/protocol": minor
---

Protocol 1.1.0: Core Web Vitals histograms, additive to pv 1. New `VITALS_METRICS`, `VITALS_BINS` (fixed bin edges for LCP, CLS and INP; the last bin is open-ended), `binFor()`, `MAX_VITALS_ROWS` (5,000) and `VITALS_ERROR_GOAL` (`"$vitals"`). Aggregate requests may carry `vitals: { from }` and responses `vitals: [{ exp, var, metric, day, bins }]`; both are optional, so 1.0.0 readers ignore them and pv 1 messages without them are unchanged. New contract fixtures `aggregate-request-vitals.json` and `aggregate-response-vitals.json`; the 1.0.0 fixtures are byte-identical.
