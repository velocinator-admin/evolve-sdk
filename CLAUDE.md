# evolve-sdk

The Evolve SDK monorepo (pnpm + Turborepo): `packages/next-evolve` (MIT, published to npm), `packages/protocol` (`@next-evolve/protocol`, MIT, published), `apps/fixture` (test Next.js site) and a fake cloud (protocol mock for tests). The private cloud lives in the sibling repo `../evolve-cloud`.

**Start every session by reading [../evolve-cloud/docs/HANDOFF.md](../evolve-cloud/docs/HANDOFF.md).** All plans and specs live in `../evolve-cloud/docs/roadmap/`. Phase 1 starts here at backlog task T0.1 (see `phase-1-backlog.md` §5).

- Backlog tasks are tagged by repo (SDK / Cloud / Site). Work SDK tasks here.
- Architecture rules that must hold:
  - No network call on the request path; the proxy reads only the local signed bundle (<5 ms p95).
  - The SDK contains no stats, bandit, AI, guardrail or plan logic; that lives in the cloud.
  - Raw events stay in the customer's Postgres; only aggregates go to the cloud, through the signed aggregate route.
  - SDK tests must run without the cloud code (use the fake cloud).
- Team: Tomer + Claude. Don't push without asking.
