import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { aiKeys, memberships } from '../db/schema.ts';
import { encryptSecret } from '../lib/crypto.ts';
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
  if (!m) return c.json({ error: 'not a member' }, 403);

  const rows = await db.query.aiKeys.findMany({
    where: eq(aiKeys.workspaceId, workspaceId),
  });
  return c.json({
    keys: rows.map(({ encryptedKey: _omit, ...k }) => k),
  });
});

// Add or update an AI key
settingsRoute.post(
  '/:workspaceId/ai-keys',
  zValidator(
    'json',
    z.object({
      provider: z.enum(['anthropic', 'openai', 'openrouter', 'ollama']),
      apiKey: z.string().min(1),
      label: z.string().default('default'),
      baseUrl: z.string().url().optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const workspaceId = c.req.param('workspaceId');
    const m = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
    });
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const { provider, apiKey, label, baseUrl } = c.req.valid('json');
    const encryptedKey = encryptSecret(apiKey);
    const id = nanoid();
    await db
      .insert(aiKeys)
      .values({ id, workspaceId, provider, label, encryptedKey, baseUrl })
      .onConflictDoUpdate({
        target: [aiKeys.workspaceId, aiKeys.provider, aiKeys.label],
        set: { encryptedKey, baseUrl },
      });
    return c.json({ ok: true });
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
    return c.json({ error: 'forbidden' }, 403);
  }
  await db
    .delete(aiKeys)
    .where(and(eq(aiKeys.id, keyId), eq(aiKeys.workspaceId, workspaceId)));
  return c.json({ ok: true });
});

export { settingsRoute };
