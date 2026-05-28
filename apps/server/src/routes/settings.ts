import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { aiKeys, memberships } from '../db/schema.ts';
import { encryptSecret } from '../lib/crypto.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { validatePublicUrl } from '../lib/url-allow-list.ts';
import { type AuthContext, getUser, requireUser } from '../middleware/auth.ts';

const settingsRoute = new Hono<AuthContext>();
settingsRoute.use('*', requireUser);

// List AI keys in workspace (returns metadata only, never the decrypted key)
settingsRoute.get('/:workspaceId/ai-keys', async (c) => {
  const user = getUser(c);
  const workspaceId = c.req.param('workspaceId');
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
  });
  if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);

  const rows = await db.query.aiKeys.findMany({
    where: eq(aiKeys.workspaceId, workspaceId),
  });
  return jsonOk(c, {
    keys: rows.map(({ encryptedKey: _omit, ...k }) => k),
  });
});

// Add or update an AI key
settingsRoute.post(
  '/:workspaceId/ai-keys',
  zValidator(
    'json',
    z
      .object({
        provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
        apiKey: z.string().min(1),
        label: z.string().default('default'),
        baseUrl: z.string().url().optional(),
      })
      .strict()
      // Fix #3 (mirrors Fix #2): baseUrl is only valid for ollama. Storing it
      // for openai/etc. would let an admin pin an attacker-controlled host
      // that the Sub-phase C runner then sends the API key to.
      .refine((b) => b.baseUrl === undefined || b.provider === 'ollama', {
        message: 'baseUrl is only allowed for the ollama provider',
        path: ['baseUrl'],
      }),
  ),
  async (c) => {
    const user = getUser(c);
    const workspaceId = c.req.param('workspaceId');
    const m = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
    });
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      throw new HTTPError('FORBIDDEN', 'forbidden', 403);
    }
    const { provider, apiKey, label, baseUrl } = c.req.valid('json');

    // B round 3 fix #2: persistence symmetry with /ai/test-key. An ollama
    // row persisted with no baseUrl falls back to DEFAULT_BASE='http://
    // localhost:11434' inside the provider wrapper — the same loopback
    // bypass the test-key route closes with fix #5. Require an explicit
    // baseUrl so the validatePublicUrl check below has something to gate on.
    if (provider === 'ollama' && baseUrl === undefined) {
      throw new HTTPError(
        'INVALID_BODY',
        'baseUrl is required for the ollama provider',
        422,
      );
    }

    // Fix #3: SSRF guard on the persistence path. Without this, an admin
    // could pin baseUrl=http://127.0.0.1:11434 or AWS metadata, and the
    // agent runner (Sub-phase C) would fetch it. Same rule as /ai/test-key.
    if (baseUrl !== undefined) {
      const v = validatePublicUrl(baseUrl);
      if (!v.ok) {
        throw new HTTPError('INVALID_BODY', v.reason, 422);
      }
    }

    const encryptedKey = encryptSecret(apiKey);
    const id = nanoid();
    await db
      .insert(aiKeys)
      .values({ id, workspaceId, provider, label, encryptedKey, baseUrl })
      .onConflictDoUpdate({
        target: [aiKeys.workspaceId, aiKeys.provider, aiKeys.label],
        set: { encryptedKey, baseUrl },
      });
    return jsonOk(c, { ok: true });
  },
);

settingsRoute.delete('/:workspaceId/ai-keys/:keyId', async (c) => {
  const user = getUser(c);
  const workspaceId = c.req.param('workspaceId');
  const keyId = c.req.param('keyId');
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
  });
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
    throw new HTTPError('FORBIDDEN', 'forbidden', 403);
  }
  await db
    .delete(aiKeys)
    .where(and(eq(aiKeys.id, keyId), eq(aiKeys.workspaceId, workspaceId)));
  return jsonOk(c, { ok: true });
});

export { settingsRoute };
