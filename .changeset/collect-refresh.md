---
"next-evolve": patch
---

Collect no longer drops exposures on a cold or stale instance: when a beacon names an experiment the instance's bundle doesn't know yet, the route fetches the bundle (at most once per 5 s per instance, waiting at most 2 s) before validating.
