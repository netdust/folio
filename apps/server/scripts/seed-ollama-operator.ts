/**
 * DEV-ONLY seed: wire the local Ollama qwen3:8b as the operator model.
 *
 * Writes the SAME two rows the Settings → AI flow produces (an ai_keys row + the
 * operator_model setting), bypassing the session-admin gate (the instance/ai-keys
 * route is session-only by design — M4 — so no token, incl. MCP, can reach it).
 *
 * IMPORTANT — this is NOT a faithful mirror of the route's WRITE PATH: it does NOT
 * run the route's SSRF guard (`validatePublicUrl(baseUrl, { allowLoopback })`,
 * instance-ai-keys.ts), which 422-rejects a loopback baseUrl unless
 * FOLIO_ALLOW_LOOPBACK_AI=true. Safe here because the target IS loopback by design,
 * but do NOT generalize this seed to a non-loopback / paid baseUrl without routing
 * it through validatePublicUrl first — it would store an unvalidated outbound host
 * the route would have blocked.
 *
 * Run from apps/server so it loads the server's own .env (same FOLIO_MASTER_KEY +
 * same folio.db) and the ciphertext it writes is decryptable by the running server.
 *
 *   cd apps/server && bun run scripts/seed-ollama-operator.ts
 *
 * Idempotent: upserts on (provider,label) for the key and on key for the setting.
 */
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../src/db/client.ts';
import { aiKeys } from '../src/db/schema.ts';
import { encryptSecret } from '../src/lib/crypto.ts';
import { setOperatorModelSetting } from '../src/services/instance-settings.ts';

const PROVIDER = 'ollama' as const;
const LABEL = 'default';
// MUST be 127.0.0.1, NOT localhost: Ollama binds only to IPv4 127.0.0.1, but
// `localhost` resolves to ::1 (IPv6) first on this box. Bun's fetch does not
// reliably fall back from ::1 to 127.0.0.1, so a `localhost` base URL throws a
// statusless "Unable to connect" → sanitized to "Network error or unreachable
// host." Pin the literal IPv4 loopback so fetch hits the address Ollama listens on.
const BASE_URL = 'http://127.0.0.1:11434';
const MODEL = 'qwen3:8b';

async function main() {
  // 1) Ollama is keyless → empty ciphertext, same as the route does.
  const encryptedKey = encryptSecret('');
  await db
    .insert(aiKeys)
    .values({ id: nanoid(), provider: PROVIDER, label: LABEL, encryptedKey, baseUrl: BASE_URL })
    .onConflictDoUpdate({
      target: [aiKeys.provider, aiKeys.label],
      set: { encryptedKey, baseUrl: BASE_URL },
    });

  const keyRow = await db.query.aiKeys.findFirst({
    where: and(eq(aiKeys.provider, PROVIDER), eq(aiKeys.label, LABEL)),
  });
  if (!keyRow) throw new Error('key row not found after upsert');

  // 2) Point the operator at it (validated through the shared schema).
  await setOperatorModelSetting(db, { provider: PROVIDER, model: MODEL, aiKeyLabel: LABEL });

  console.log('Seeded:');
  console.log(`  ai_keys: ${PROVIDER}/${LABEL}  base_url=${keyRow.baseUrl}  id=${keyRow.id}`);
  console.log(`  operator_model: { provider: '${PROVIDER}', model: '${MODEL}', aiKeyLabel: '${LABEL}' }`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('SEED FAILED:', e);
    process.exit(1);
  },
);
