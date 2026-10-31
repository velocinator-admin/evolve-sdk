# evolve-sdk

Monorepo for the Evolve SDK. Plans and specs live in `../evolve-cloud/docs/roadmap/`.

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
