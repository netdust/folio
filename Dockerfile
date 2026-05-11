# --- 1. Install + build the web ---
FROM oven/bun:1.1.34-alpine AS web-build
WORKDIR /app
COPY package.json bun.lockb* ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run --filter @folio/web build

# --- 2. Build the server (single binary via bun compile) ---
FROM oven/bun:1.1.34-alpine AS server-build
WORKDIR /app
COPY --from=web-build /app /app
RUN bun build apps/server/src/index.ts \
    --compile \
    --target=bun-linux-x64 \
    --outfile /folio

# --- 3. Runtime image ---
FROM alpine:3.20
RUN apk add --no-cache libstdc++ libgcc ca-certificates
WORKDIR /data
COPY --from=server-build /folio /usr/local/bin/folio
COPY --from=web-build /app/apps/web/dist /web/dist
COPY --from=web-build /app/apps/server/src/db/migrations /app/migrations
ENV NODE_ENV=production
ENV DATABASE_URL=file:/data/folio.db
EXPOSE 3000
CMD ["/usr/local/bin/folio"]
