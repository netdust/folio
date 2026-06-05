import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { aiKeys } from '../db/schema.ts';
import { env } from '../env.ts';
import { encryptSecret } from '../lib/crypto.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { requireInstanceAdmin } from '../lib/system-workspace.ts';
import { validatePublicUrl } from '../lib/url-allow-list.ts';
import { type AuthContext, getUser, requireSessionUser } from '../middleware/auth.ts';

/**
 * Instance AI-key administration — `/api/v1/instance/ai-keys`.
 *
 * AI provider credentials are INSTANCE-level (workspace-independent): a key is
 * identified by (provider, label) and the runner resolves an agent's key by
 * (provider, ai_key_label) with no workspace tie (the B6 reversal). Moving CRUD
 * here (off the old per-workspace settings route) is the route-truth half of
 * that change.
 *
 * Gate (M4): SESSION user only (no bearers — the secret store must not be
 * reachable by any minted token, including an agent's), AND that user must be a
 * __system owner/admin (requireInstanceAdmin). This route mounts on v1 (not
 * wScope), so attachToken never runs and a Bearer has no `user` → requireSessionUser
 * rejects it. NEVER returns encryptedKey (M1/M3).
 */
const instanceAiKeysRoute = new Hono<AuthContext>();
instanceAiKeysRoute.use('*', requireSessionUser);

instanceAiKeysRoute.get('/', async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);
  const rows = await db.query.aiKeys.findMany();
  // M1/M3 — strip the secret; the GET surface returns metadata only.
  return jsonOk(c, { keys: rows.map(({ encryptedKey: _omit, ...k }) => k) });
});

instanceAiKeysRoute.post(
  '/',
  zValidator(
    'json',
    z
      .object({
        provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
        apiKey: z.string().min(1),
        label: z.string().min(1).default('default'),
        baseUrl: z.string().url().optional(),
      })
      .strict()
      // baseUrl is only valid for ollama. Storing it for openai/etc. would let an
      // admin pin an attacker-controlled host the runner then sends the key to.
      .refine((b) => b.baseUrl === undefined || b.provider === 'ollama', {
        message: 'baseUrl is only allowed for the ollama provider',
        path: ['baseUrl'],
      }),
  ),
  async (c) => {
    await requireInstanceAdmin(db, getUser(c).id);
    const { provider, apiKey, label, baseUrl } = c.req.valid('json');

    // An ollama row with no baseUrl falls back to DEFAULT_BASE='http://
    // localhost:11434' inside the provider wrapper — the same loopback bypass
    // the test-key route closes. Require an explicit baseUrl so the
    // validatePublicUrl guard below has something to gate on.
    if (provider === 'ollama' && baseUrl === undefined) {
      throw new HTTPError('INVALID_BODY', 'baseUrl is required for the ollama provider', 422);
    }

    // SSRF guard on the persistence path. Without this, an admin could pin
    // baseUrl=http://127.0.0.1:11434 or AWS metadata and the runner would fetch
    // it. LOOPBACK ESCAPE HATCH: self-hosted Ollama runs on the same box, so
    // localhost is permitted ONLY for ollama AND ONLY when the operator opted in
    // via FOLIO_ALLOW_LOOPBACK_AI (off by default → SSRF guard fully closed).
    if (baseUrl !== undefined) {
      const allowLoopback = provider === 'ollama' && env.FOLIO_ALLOW_LOOPBACK_AI;
      const v = validatePublicUrl(baseUrl, { allowLoopback });
      if (!v.ok) throw new HTTPError('INVALID_BODY', v.reason, 422);
    }

    // M8 fail-loud trigger: a PAID provider makes the denial-of-wallet residual
    // LIVE. Per-key usage CAPS are not built (metered residual — see spec); any
    // agent in any workspace can now draw on this shared instance key. Log loudly
    // so the operator sees the residual the moment it becomes exploitable.
    const paidResidualLive = provider !== 'ollama';
    if (paidResidualLive) {
      console.warn(
        `[ai-keys] denial-of-wallet residual is now LIVE: a paid provider key ` +
          `(${provider}/${label}) was added to the instance store. Per-key usage ` +
          `CAPS are NOT built (metered residual — see spec). Any agent in any ` +
          `workspace can now draw on this key.`,
      );
    }

    const encryptedKey = encryptSecret(apiKey);
    // `.returning` gives the ACTUAL row id: on an INSERT it's the new id; on a
    // conflict-UPDATE (same provider+label) it's the EXISTING row's id (the
    // update sets only encryptedKey/baseUrl, never id). Returning the pre-
    // generated nanoid would lie on the update path (response.id ≠ DB id).
    const [row] = await db
      .insert(aiKeys)
      .values({ id: nanoid(), provider, label, encryptedKey, baseUrl })
      .onConflictDoUpdate({
        target: [aiKeys.provider, aiKeys.label],
        set: { encryptedKey, baseUrl },
      })
      .returning({ id: aiKeys.id });
    return jsonOk(c, { id: row!.id, provider, label, paid_residual_live: paidResidualLive }, 201);
  },
);

instanceAiKeysRoute.delete('/:keyId', async (c) => {
  await requireInstanceAdmin(db, getUser(c).id);
  const deleted = await db
    .delete(aiKeys)
    .where(eq(aiKeys.id, c.req.param('keyId')))
    .returning({ id: aiKeys.id });
  if (deleted.length === 0) throw new HTTPError('NOT_FOUND', 'AI key not found', 404);
  return jsonOk(c, { ok: true });
});

export { instanceAiKeysRoute };
