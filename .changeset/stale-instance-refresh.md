---
"next-evolve": patch
---

Stale instances no longer drop real visits (T19.5 rollback drill). On Vercel, an instance holding an older bundle dropped the exposures and vitals of an experiment started meanwhile.

- Collect now waits for a refresh from the cloud when a beacon names an experiment or variant its bundle doesn't know. It shares a refresh already in flight instead of giving up inside the 5 s window. If that fetch predates the publish, it does a second round. It then counts what the newer signed bundle knows.
- The proxy starts the same refresh in the background (`waitUntil`) when a returning visitor's cookie names an experiment or variant its bundle doesn't know.
- On-demand refreshes ask the cloud directly, so a stale Global Config item can't hide a newer bundle. A failed cloud call no longer starts a new 60 s wait.
- The proxy, collect and the render path's `fresh` pull share one budget: at most one on-demand cloud fetch per 5 s per instance.
- A background fetch that never settles (an instance frozen without `waitUntil`) stops blocking refreshes after 15 s. Network and 5xx failures are retried after 10 s, not a full poll interval. Collect's background poll is now handed to `after()`.
