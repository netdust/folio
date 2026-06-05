/**
 * One-off: seed an INSTANCE Ollama ai_keys row, writing the SAME encrypted row
 * the POST /api/v1/instance/ai-keys route would. AI keys are instance-level (no
 * workspace tie since migration 0023); idempotent on (provider, label). Run from
 * apps/server so .env (FOLIO_MASTER_KEY) loads:
 *   bun run scripts/seed-ollama-key.ts [base_url] [label]
 */
import { Database } from 'bun:sqlite';
import { encryptSecret } from '../src/lib/crypto.ts';

const baseUrl = process.argv[2] ?? 'http://localhost:11434';
const label = process.argv[3] ?? 'default';
const dbPath = (process.env.DATABASE_URL ?? 'file:./folio.db').replace(/^file:/, '');

const db = new Database(dbPath);

// Ollama needs no real key; buildOllamaHeaders only sends Authorization when the
// key is non-empty, and a localhost base_url never triggers it. Store a marker so
// the schema's non-empty invariant holds and decrypt round-trips.
const encryptedKey = encryptSecret('ollama-local-no-key');
const id = crypto.randomUUID();

db.query(
  `insert into ai_keys (id, provider, label, encrypted_key, base_url)
   values (?, 'ollama', ?, ?, ?)
   on conflict (provider, label)
   do update set encrypted_key = excluded.encrypted_key, base_url = excluded.base_url`,
).run(id, label, encryptedKey, baseUrl);

const row = db
  .query('select id, provider, label, base_url from ai_keys where provider = ? and label = ?')
  .get('ollama', label);
console.log('seeded instance ollama key:', JSON.stringify(row, null, 2));
