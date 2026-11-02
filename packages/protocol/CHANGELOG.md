# @next-evolve/protocol

## 1.1.0

### Minor Changes

- febe201: Protocol 1.1.0: Core Web Vitals histograms, additive to pv 1. New `VITALS_METRICS`, `VITALS_BINS` (fixed bin edges for LCP, CLS and INP; the last bin is open-ended), `binFor()`, `MAX_VITALS_ROWS` (5,000) and `VITALS_ERROR_GOAL` (`"$vitals"`). Aggregate requests may carry `vitals: { from }` and responses `vitals: [{ exp, var, metric, day, bins }]`; both are optional, so 1.0.0 readers ignore them and pv 1 messages without them are unchanged. New contract fixtures `aggregate-request-vitals.json` and `aggregate-response-vitals.json`; the 1.0.0 fixtures are byte-identical.

## 1.0.0

### Major Changes

- Phase 1 alpha release (T12.8). `@next-evolve/protocol` 1.0.0 freezes wire protocol v1 (bundle, signatures, aggregate request/response, manifest and region schemas); no changes from 0.1.0. `next-evolve` 0.4.0 depends on it and is published as both `latest` and `alpha`.

## 0.1.0

### Minor Changes

- 87d2e91: First public release.
