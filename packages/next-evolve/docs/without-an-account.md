# What the SDK does without an account

`next-evolve` is MIT-licensed, but on its own it doesn't run experiments: the configuration (the signed bundle), the statistics and the dashboard come from Evolve Cloud. Without a working connection, your site keeps working as if Evolve weren't there.

## No account, no key, or no bundle yet

If `EVOLVE_SECRET_KEY` isn't set, the key is invalid, or the site has never started an experiment:

- Every page renders **control**: the props in your code.
- **No cookies** are set.
- **Nothing is recorded** (no assignments means no exposures; the collect route drops visitors without an `evolve_id` cookie).
- There's no network call on the request path. In the background the SDK tries to fetch a bundle (every 60 s) and logs `no bundle yet (no experiment has started): serving control` or `bundle fetch failed (…)`, at most once a minute.
- `npx next-evolve pull` writes an empty build bundle and never fails the build.

Removing Evolve is the same as never having added it: delete the `<Optimizable>` wrappers (render the component directly) or leave them; they render control.

## The cloud becomes unreachable

- **Up to 14 days:** the app serves the last bundle it verified. Experiments keep running with their last weights, events keep being written to your database, and the next aggregate after the outage counts them.
- **After 14 days** (the bundle's expiry): control for everyone, no new cookies. Events from visitors who already have an `evolve_id` cookie, and server events (`evolve.track`, `/api/evolve/track`), are still written; new visitors aren't recorded.

## The key is revoked or the site deleted

The cloud answers `401`, which the SDK treats like an outage: the last bundle serves until it expires (at most 14 days), then control. There's no instant kill switch; to stop an experiment at once, pause it in the dashboard.

## Your database is missing or down

Serving never touches the database, so variants keep serving. Measurement stops: on serverless hosts events are dropped (one retry); on long-running Node up to 10,000 rows are buffered and written when the database is back (oldest dropped first beyond that). The aggregate route answers `503 database_error`.
