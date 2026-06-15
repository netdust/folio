# --- 1. Build the single binary (web bundle + migrations embedded via scripts/build.ts) ---
# Bun 1.3.8 aligns with dev; it has reliable `--compile` asset embedding, which
# scripts/build.ts (Audit H1) relies on to embed web/dist + migrations into the binary.
#
# glibc (Debian) base. The `--compile` binary links against the BUILD env's libc,
# so the RUNTIME stage below MUST share it (a glibc binary crashes on a musl
# loader, and vice-versa); both stages are glibc to stay consistent.
FROM oven/bun:1.3.8 AS build
WORKDIR /app

# Text lockfile (bun.lock, not the legacy binary bun.lockb). A frozen-lockfile
# failure MUST fail the build — no silent unpinned fallback.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
# --ignore-scripts: bun's trusted-dependencies gate BLOCKS @biomejs/biome's
# postinstall, and under --frozen-lockfile bun counts that blocked script as a
# failed install ("Failed to install 1 package") → exit 1. Biome is a dev-only
# linter the binary build never runs, so we skip lifecycle scripts entirely. This
# keeps the lockfile HARD frozen (H2) — no `|| bun install` fallback, no unpin.
RUN bun install --frozen-lockfile --ignore-scripts

# build:binary runs the full web build (filter '*') + manifest generation + the
# embedding compile, so it needs the full source tree.
COPY . .
RUN bun run build:binary

# --- 2. Runtime image ---
# The binary is self-contained: it serves the embedded React bundle and runs boot
# migrations from embedded .sql — no web/dist or migrations dir on disk needed.
#
# glibc runtime (Debian) to match the glibc-linked compiled binary from the build
# stage above. The compiled bun binary needs libstdc++6 (+ libgcc/libc, already in
# the base); ca-certificates for outbound TLS (BYOK providers); wget for the
# docker-compose healthcheck.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /data
COPY --from=build /app/dist/folio /usr/local/bin/folio
ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/folio.db
EXPOSE 3000
CMD ["/usr/local/bin/folio"]
