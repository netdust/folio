/**
 * Side-effect module: ensures the env vars required by `../env.ts` exist
 * before any test loads it. Wired as a Bun `preload` in `bunfig.toml`, so it
 * runs before ANY test module imports `env.ts`/`crypto.ts` — including the test
 * files that import those directly (not via `harness.ts`).
 *
 * FOLIO_MASTER_KEY is FORCED (assigned, not `??=`): Bun auto-loads
 * `apps/server/.env` before this runs, so a developer's local key would
 * otherwise win and make crypto.ts derive the wrong key at module load —
 * a false-RED on the ciphertext-format-stability fixture (crypto.test.ts).
 * The deterministic test key keeps the suite reproducible in every environment.
 */

process.env.NODE_ENV ??= 'test';
process.env.FOLIO_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
