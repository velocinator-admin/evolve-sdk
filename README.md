# evolve-sdk

The open-source SDK for [Evolve](https://evolveab.com): A/B tests and bandits for Next.js App Router, rendered on the server with no flicker. Visitor-level data stays in your own Postgres; Evolve Cloud only sees aggregate counts. AI-written variants, autopilot and winner pull requests run in Evolve Cloud.

- Docs and quickstart: [evolveab.com/docs](https://evolveab.com/docs)
- Start a free 30-day trial: [app.evolveab.com](https://app.evolveab.com)
- npm: [`next-evolve`](https://www.npmjs.com/package/next-evolve), [`@next-evolve/protocol`](https://www.npmjs.com/package/@next-evolve/protocol)

The SDK needs an Evolve Cloud account: without a valid signed config bundle, every visitor gets the control version. The code is MIT so you can read and security-review what runs on your servers.

Found a bug? Open an issue.

## Repository

| Path                   | What                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `packages/protocol`    | `@next-evolve/protocol` (MIT, published): wire protocol schemas and verification |
| `packages/next-evolve` | `next-evolve` (MIT, published): the SDK                                          |
| `packages/fake-cloud`  | private protocol mock of Evolve Cloud for tests                                  |
| `apps/fixture`         | Next.js 16 test site                                                             |

## Develop

```sh
pnpm install
pnpm db:up          # customer Postgres on localhost:54329 (docker compose)
pnpm build && pnpm test
pnpm --filter fixture dev   # http://localhost:3100
```

Requires Node ≥ 22.12, pnpm 10, Docker.

## License

MIT, see [LICENSE](LICENSE).
