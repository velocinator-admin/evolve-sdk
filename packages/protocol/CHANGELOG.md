# @next-evolve/protocol

## 1.3.0

### Minor Changes

- c4079ac: Protocol 1.3.0: UTM rules (D75), additive to pv 1. Bundles may carry an optional top-level `rules: [{ id, exp, var, when: [{ f, op, v }] }]` in dashboard order (all conditions AND; first match per experiment wins). Fields `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `ref` (referrer host), `country`, `device`; operators `eq`, `in`, `prefix`, `re`. Limits: 20 rules per experiment, 50 per bundle, 10 conditions per rule, values ≤ 200 chars. The bundle schema checks that each rule's experiment is running and its variant belongs to it; `f`/`op` stay open strings for readers (an unknown one makes the evaluator skip the rule), while the new `ruleSchema`/`condSchema` are strict for writers. The signed `hash` still covers routing + variants only, so 1.2.0 readers verify a bundle with rules and ignore them; the new `computeContentHash()` also covers `rules` when present, for change detection. New fixture `bundle-payload-rules.json`; every 1.2.0 fixture is byte-identical.

## 1.2.0

### Minor Changes

- b8bc6e6: Pull-mode aggregation (AGG-2): `aggregate: { mode: "pull" }` in `evolve.config.ts` makes `registerEvolve()` on a long-running Node server poll `GET /v1/aggregate-requests` every 60 s, answer each signed request with the same code as the aggregate route, and post the signed result to `POST /v1/aggregates`. For servers the cloud can't reach. Push stays the default. Protocol 1.2.0 adds `aggregatePullSchema`, `AGGREGATE_PULL_PATH` and the `aggregate-pull.json` fixture; existing messages and fixtures are unchanged.

## 1.1.0

### Minor Changes

- febe201: Protocol 1.1.0: Core Web Vitals histograms, additive to pv 1. New `VITALS_METRICS`, `VITALS_BINS` (fixed bin edges for LCP, CLS and INP; the last bin is open-ended), `binFor()`, `MAX_VITALS_ROWS` (5,000) and `VITALS_ERROR_GOAL` (`"$vitals"`). Aggregate requests may carry `vitals: { from }` and responses `vitals: [{ exp, var, metric, day, bins }]`; both are optional, so 1.0.0 readers ignore them and pv 1 messages without them are unchanged. New contract fixtures `aggregate-request-vitals.json` and `aggregate-response-vitals.json`; the 1.0.0 fixtures are byte-identical.

## 1.0.0

### Major Changes

- Phase 1 alpha release (T12.8). `@next-evolve/protocol` 1.0.0 freezes wire protocol v1 (bundle, signatures, aggregate request/response, manifest and region schemas); no changes from 0.1.0. `next-evolve` 0.4.0 depends on it and is published as both `latest` and `alpha`.

## 0.1.0

### Minor Changes

- 87d2e91: First public release.
