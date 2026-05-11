/**
 * Side-effect module: ensures the env vars required by `../env.ts` exist
 * before any test loads it. Imported first by `harness.ts` so its statics run
 * before downstream imports trigger `env.ts` parsing.
 */

process.env.NODE_ENV ??= 'test';
process.env.SESSION_SECRET ??= 'test-session-secret-test-session-secret-xx';
process.env.FOLIO_MASTER_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
