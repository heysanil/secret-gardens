# safe — self-hosted secrets manager.
# Build from the REPO ROOT: docker build -f docker/Dockerfile .
# (docker-compose.yml does this for you.)

# ---------------------------------------------------------------- build stage
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Workspace manifests first so `bun install` layers cache independently of
# source changes.
#
# ADDING A WORKSPACE? Add its package.json COPY here AND in the runtime
# stage below. These lists must mirror `workspaces` in package.json — a
# missing manifest fails `bun install --frozen-lockfile` with an opaque
# lockfile error.
COPY package.json bun.lock bunfig.toml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY packages/crypto/package.json packages/crypto/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/

RUN bun install --frozen-lockfile

COPY . .

# Build the web UI (Vite). Type checking runs in CI, not here.
RUN cd apps/web && bun run build

# -------------------------------------------------------------- runtime stage
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Full workspace source — the API runs straight from TypeScript under Bun.
#
# ADDING A WORKSPACE? Add its package.json COPY here too (see the build
# stage above) — `bun install --frozen-lockfile` needs every workspace
# manifest present. e2e/package.json (and apps/web's) exist only to
# satisfy the lockfile's workspace set.
COPY package.json bun.lock bunfig.toml turbo.json tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/cli apps/cli
COPY apps/web/package.json apps/web/package.json
COPY packages packages
COPY e2e/package.json e2e/package.json

# Production dependencies only (no vite/typescript/biome toolchain).
RUN bun install --production --frozen-lockfile

# Built web UI from the build stage.
COPY --from=build /app/apps/web/dist apps/web/dist

# SQLite lives on a volume; make it writable for the non-root `bun` user.
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data

ENV SAFE_WEB_DIST=/app/apps/web/dist \
    SAFE_DB_PATH=/data/safe.db \
    PORT=3000

EXPOSE 3000

USER bun

# wget/curl-free healthcheck via Bun itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "apps/api/src/index.ts"]
