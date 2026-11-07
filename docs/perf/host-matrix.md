# Host matrix (HOST-1, Phase 3)

The fixture's e2e and the request-path benchmark ([phase-1.md](phase-1.md), `apps/fixture/scripts/perf.ts`) on each host the SDK supports. The nightly workflow (`.github/workflows/host-matrix.yml`) reruns this and writes the table into its job summary.

| Host | How it runs | e2e |
|---|---|---|
| Node | `next start` (the fixture e2e's default) | full fixture e2e |
| Docker | `output: "standalone"` image (`apps/fixture/Dockerfile.standalone`, `node server.js`); the e2e's main instance runs in the container (`E2E_APP_HOST=docker`) | full fixture e2e |
| Vercel | the production fixture, `https://fixture.evolveab.com` | host smoke (`apps/fixture/e2e-host`) |
| Netlify, Cloudflare | not run: both need accounts (parked). See the SDK docs' hosting page | — |

## Running it locally

```sh
pnpm build                       # packages + fixture (.next)
# Node
E2E_PORT_OFFSET=500 EVOLVE_DATABASE_URL=postgres://evolve:evolve@localhost:54329/<db> \
  pnpm --filter fixture test:e2e
node --experimental-strip-types apps/fixture/scripts/perf.ts --port-base 3620
# Docker (standalone image, and the perf baseline image)
docker build -f apps/fixture/Dockerfile.standalone -t evolve-fixture-standalone .
docker build -f apps/fixture/Dockerfile.standalone --build-arg EVOLVE_PERF_BASELINE=1 \
  -t evolve-fixture-standalone-baseline .
E2E_APP_HOST=docker E2E_PORT_OFFSET=500 EVOLVE_DATABASE_URL=… pnpm --filter fixture test:e2e
node --experimental-strip-types apps/fixture/scripts/perf.ts --host docker --port-base 3620
# Vercel (smoke + a slow, throttled benchmark; Vercel challenges fast runs from one IP)
HOST_URL=https://fixture.evolveab.com pnpm --filter fixture test:e2e:host
```

`E2E_PORT_OFFSET` moves every e2e port (apps 3100–3107, fake cloud 4010), so two checkouts can run side by side; the e2e drops and recreates the `evolve` schema of `EVOLVE_DATABASE_URL`, so give each checkout its own database.

## Results, 2026-11-07 (T23.1)

Tomer's MacBook (Node 22.13 on the host, Node 24.22 in the container, Next 16.4.3, Docker Desktop), 200 warm-up + 2,000 alternating samples per scenario. The machine was busy (load average ~13, other builds running), so read the Docker row as an upper bound. Added = Evolve minus baseline TTFB at p95; in-proxy = `Server-Timing: evolve;dur` p95. All ms.

| Scenario | Node added p95 | Node in-proxy p95 | Docker added p95 | Docker in-proxy p95 |
|---|---|---|---|---|
| `/` static, returning visitor | 0.40 | 0.05 | 0.64 | 0.09 |
| `/` static, new visitor | 0.45 | 0.10 | 0.48 | 0.16 |
| `/pricing` static, returning visitor | 0.26 | 0.04 | 0.52 | 0.08 |
| `/features` dynamic, returning visitor | 0.74 | 0.10 | 2.88 | 0.47 |
| `/` static, bot | 0.27 | 0.02 | 1.38 | 0.09 |

- **Both within budget** (added < 5 ms, in-proxy < 1 ms). On Docker Desktop every request also crosses the VM's port forwarder, which widens both columns; the baseline's own `/features` p95 was 14 ms there vs. 3.8 ms on the host. An earlier Docker run on the same busy machine measured `/features` +5.38 ms added (baseline p95 20.8 ms), so the nightly run on a Linux runner (no VM) is the number to watch.
- **e2e:** 39 tests on each host. Node and Docker both passed 38 in a full parallel run; the one miss on each was `cdn.spec.ts` "a pause reaches a returning visitor within the cookie's lifetime" at 10,044–10,046 ms against its 10,000 ms limit (the `cdn` instance runs on `next start` in both modes). It passes when run alone; the nightly runs with `--retries 1`.
- **Vercel:** this laptop's IP was challenged by Vercel's DDoS mitigation (`403 x-vercel-mitigated: challenge`) after a few dozen requests, as in Phase 1, so the host smoke skipped and the benchmark kept 60 clean `/pricing` samples: in-proxy p95 0.46 ms, added TTFB p95 +15 ms (the platform's proxy invocation, spec §6.6). The nightly runs from a fresh runner IP at a slow rate.
