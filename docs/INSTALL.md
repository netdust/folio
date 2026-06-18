# Installing Folio

Folio ships as a single self-contained binary backed by a SQLite file. There are no sidecar services, no separate worker, and no database server required.

## Quick start

### Binary

> **Note:** pre-built release binaries are not published yet. Until CI publishes
> them, build the binary from source (see "Building from source" below), then:

```bash
# Generate the required secret
export FOLIO_MASTER_KEY=$(openssl rand -hex 32)

./folio
```

### Docker

```bash
docker run -d \
  -v ./data:/data \
  -p 3000:3000 \
  -e FOLIO_MASTER_KEY=<64-hex-chars> \
  folio:latest
```

The binary serves both the REST API and the compiled React SPA from a single port.

## Reverse proxy

Folio expects to sit behind a reverse proxy (nginx, Caddy, Traefik). Set `PUBLIC_URL` to the externally-reachable HTTPS URL so magic-link emails and SSE keep-alives use the correct base.

**Folio MUST run behind a reverse proxy that sets a trustworthy `X-Forwarded-For`** (Ploi/nginx and Caddy do this by default). The per-IP login rate-limiter keys on that header; on a no-proxy deploy every client collapses into the single `'unknown'` IP bucket, so the per-IP throttle protects all clients as one (the per-email throttle still works per account). This is acceptable degradation, not a failure — but a public-facing instance should always be proxied so per-IP throttling is real. (Security Low-1: the limiter trusts `X-Forwarded-For`; do not expose Folio directly to the internet.)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the server listens on. |
| `PUBLIC_URL` | `http://localhost:3000` | Externally reachable base URL. Used in magic-link emails and CORS. Must be a valid URL. |
| `DATABASE_URL` | `file:./folio.db` | SQLite connection string. For a persistent install, point this at a directory that survives restarts (e.g. `file:/data/folio.db`). |
| `FOLIO_MASTER_KEY` | *(required)* | Exactly 64 hex characters (32 bytes). Encrypts BYOK AI keys at rest via AES-256-GCM (@noble/ciphers). Changing this invalidates all stored keys. |
| `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` | `false` | Set to `true` for the **first boot only** to allow the first-ever user to self-register as the instance owner. Turn it back off (or leave unset) once the owner exists. Alternatively set `FOLIO_INSTANCE_OWNER`. |
| `FOLIO_INSTANCE_OWNER` | *(optional)* | Email of the instance owner. On boot, the user with this email is promoted to owner (idempotent). Use this instead of `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION` when you know the owner's email in advance. |
| `SMTP_HOST` | *(optional)* | SMTP relay hostname. Magic-link emails are only sent when this is set; otherwise the link is printed to the server console (dev mode). |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` | *(optional)* | SMTP username. |
| `SMTP_PASS` | *(optional)* | SMTP password. |
| `SMTP_FROM` | `Folio <no-reply@example.com>` | From address used for outbound email. |
| `FOLIO_CLAUDE_CODE_ENABLED` | `false` | Enable the `claude-code` runner backend (spawns the local `claude` CLI with host SSH/file access) so the **operator** can run on your own local Claude Code login. Only takes effect on **attended operator/cockpit runs** — triggers (unattended automation) can never use it, even with the flag on. **Single-operator local/personal installs only — NEVER set it on a per-customer or shared host:** the subprocess runs with your own seat's full host power, and using a subscription seat to serve another person's work violates Anthropic's terms. Requires the `claude` binary on PATH, authenticated as you. Leave unset on customer images. |

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
