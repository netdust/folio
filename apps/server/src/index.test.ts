import { describe, expect, test } from 'bun:test';

// F shake-out (F-4): the server export MUST disable Bun's idle-connection
// reaper, or Bun's 10s default kills idle SSE streams (the provider-health /
// reactor-halt banners + runs live-sync in routes/events.ts) 20s before the
// 30s heartbeat can keep them alive — a reconnect storm. Bun's idle timer is
// not reset by the server's heartbeat writes, so the timeout must be disabled
// (0), not merely raised. This pins the config so a future edit can't silently
// reintroduce the reaper and break every SSE consumer.
//
// Importing index.ts is side-effect-safe under NODE_ENV=test: runMigrationsOnBoot
// returns early, and the reconciler/dispatcher/poller are all gated on
// `env.NODE_ENV !== 'test'`.
describe('server export', () => {
  test('disables Bun idleTimeout (0) so long-lived SSE streams are not reaped', async () => {
    const mod = await import('./index.ts');
    const server = mod.default as { idleTimeout?: number; port?: number };
    expect(server.idleTimeout).toBe(0);
  });
});
