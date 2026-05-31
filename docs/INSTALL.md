# Installing Folio

Folio ships as a single self-contained binary backed by a SQLite file. There are no sidecar services, no separate worker, and no database server required.

## Quick start

### Binary

```bash
# Download the release binary (replace <version> and <platform>)
curl -Lo folio https://github.com/netdust/folio/releases/download/<version>/folio-<platform>
chmod +x folio

# Generate required secrets
export FOLIO_MASTER_KEY=$(openssl rand -hex 32)
export SESSION_SECRET=$(openssl rand -base64 48)

./folio
```

### Docker

```bash
docker run -d \
  -v ./data:/data \
  -p 3000:3000 \
  -e FOLIO_MASTER_KEY=<64-hex-chars> \
  -e SESSION_SECRET=<min-32-chars> \
  folio:latest
```

The binary serves both the REST API and the compiled React SPA from a single port.

## Reverse proxy

Folio expects to sit behind a reverse proxy (nginx, Caddy, Traefik). Set `PUBLIC_URL` to the externally-reachable HTTPS URL so magic-link emails and SSE keep-alives use the correct base.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the server listens on. |
| `PUBLIC_URL` | `http://localhost:3000` | Externally reachable base URL. Used in magic-link emails and CORS. Must be a valid URL. |
| `DATABASE_URL` | `file:./folio.db` | SQLite connection string. For a persistent install, point this at a directory that survives restarts (e.g. `file:/data/folio.db`). |
| `SESSION_SECRET` | *(required)* | At least 32 characters. Signs session cookies. Rotate with a server restart — all active sessions are invalidated. |
| `FOLIO_MASTER_KEY` | *(required)* | Exactly 64 hex characters (32 bytes). Encrypts BYOK AI keys at rest via libsodium. Changing this invalidates all stored keys. |
| `SMTP_HOST` | *(optional)* | SMTP relay hostname. Magic-link emails are only sent when this is set; otherwise the link is printed to the server console (dev mode). |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` | *(optional)* | SMTP username. |
| `SMTP_PASS` | *(optional)* | SMTP password. |
| `SMTP_FROM` | `Folio <no-reply@example.com>` | From address used for outbound email. |
| `FOLIO_CLAUDE_CODE_ENABLED` | `false` | Enable the `claude-code` runner backend (spawns the local `claude` CLI with host SSH/file access). Local/personal installs only — NEVER on a shared host with fleet credentials. Requires the `claude` binary on PATH. |

### Advanced tuning

| Variable | Default | Description |
|---|---|---|
| `FOLIO_AGENT_CHAINS_ENABLED` | `false` | Allow agent-originated chains (an agent's reply/mention fans out another run). Off by default as an autonomy safeguard. |
| `FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE` | `100` | Hard cap on agent runs per workspace per rolling hour. |
| `FOLIO_MAX_RUNS_PER_HOUR_PER_AGENT` | `50` | Hard cap on runs per agent per rolling hour. |
| `FOLIO_MAX_CHAIN_FANOUT` | `25` | Maximum number of descendent runs a single chain may spawn. |
| `FOLIO_MAX_CHAIN_DURATION_MS` | `1800000` (30 min) | Wall-clock budget per chain in milliseconds. |
| `FOLIO_MAX_CHAIN_TOKENS` | `200000` | Cumulative token budget per chain across all runs. |
| `FOLIO_POLLER_INTERVAL_MS` | `1000` | How often the runner poller checks for queued runs (ms). Floor: 100 ms. |
| `FOLIO_POLLER_CONCURRENCY` | `5` | Maximum number of agent runs executing concurrently per server process. |
| `FOLIO_WORKER_STALE_MS` | `300000` (5 min) | A `running` run older than this is treated as orphaned and recovered on next boot. |
| `FOLIO_DISPATCHER_INTERVAL_MS` | `1000` | Reaction-plane event dispatcher poll cadence (ms). Floor: 100 ms. |
| `FOLIO_DISPATCHER_BATCH` | `100` | Maximum events drained per dispatcher tick. |
| `FOLIO_RECONCILER_INTERVAL_MS` | `3600000` (1 hr) | Agent allow-list reconciler poll interval — cleans up project references after project deletion. Floor: 60 s. |

## Building from source

```bash
git clone https://github.com/netdust/folio
cd folio
bun install
bun run build          # React → embed → bun compile → ./folio binary
```

See `CLAUDE.md` for the full development workflow.
