/**
 * One-off: seed an Ollama ai_keys row for a workspace, writing the SAME
 * encrypted row the POST /ai-keys route would. Idempotent on
 * (workspace_id, provider, label). Run from apps/server so .env (FOLIO_MASTER_KEY)
 * loads:  bun run scripts/seed-ollama-key.ts <workspace_slug> [base_url]
 */
import { Database } from 'bun:sqlite';
import { encryptSecret } from '../src/lib/crypto.ts';

const slug = process.argv[2] ?? 'netdust';
const baseUrl = process.argv[3] ?? 'http://localhost:11434';
const dbPath = (process.env.DATABASE_URL ?? 'file:./folio.db').replace(/^file:/, '');

const db = new Database(dbPath);
const ws = db.query('select id, slug from workspaces where slug = ?').get(slug) as
  | { id: string; slug: string }
  | undefined;
if (!ws) throw new Error(`workspace not found: ${slug}`);

// Ollama needs no real key; buildOllamaHeaders only sends Authorization when the
// key is non-empty, and a localhost base_url never triggers it. Store a marker so
// the schema's non-empty invariant holds and decrypt round-trips.
const encryptedKey = encryptSecret('ollama-local-no-key');
const id = crypto.randomUUID();

db.query(
  `insert into ai_keys (id, workspace_id, provider, label, encrypted_key, base_url)
   values (?, ?, 'ollama', 'default', ?, ?)
   on conflict (workspace_id, provider, label)
   do update set encrypted_key = excluded.encrypted_key, base_url = excluded.base_url`,
).run(id, ws.id, encryptedKey, baseUrl);

const row = db
  .query('select id, workspace_id, provider, label, base_url from ai_keys where workspace_id = ? and provider = ?')
  .get(ws.id, 'ollama');
console.log('seeded ollama key:', JSON.stringify(row, null, 2));
