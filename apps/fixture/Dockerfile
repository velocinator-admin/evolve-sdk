# The fixture as a plain Node host (spec §7.8 "Plain Node / Docker"), built from
# the monorepo source. Build from the repo root:
#   docker compose -f apps/fixture/docker-compose.yml up --build
# EVOLVE_SECRET_KEY reaches the build as a BuildKit secret (never an image layer):
# `next-evolve pull` writes the build bundle and static pages register their regions.
FROM node:24.22.1-alpine
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter='fixture^...'
WORKDIR /repo/apps/fixture
RUN --mount=type=secret,id=evolve_secret_key,env=EVOLVE_SECRET_KEY pnpm run build
ENV NODE_ENV=production
EXPOSE 3000
# Migrates its own Postgres, then serves. The disk bundle cache lives in the container's tmpdir.
CMD ["sh", "-c", "pnpm exec next-evolve migrate && exec pnpm exec next start --port 3000"]
