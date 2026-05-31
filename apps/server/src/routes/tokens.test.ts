import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

// POST /api/v1/w/:wslug/tokens/:workspaceId
// DELETE /api/v1/w/:wslug/tokens/:workspaceId/:tokenId
//
// B round 5 #1, #2 — tokens.ts POST + DELETE are session-only. A stolen
// workspace Bearer must not be able to mint a higher-scope replacement
// (POST) or revoke peer Bearers (DELETE). Threat model mitigation 11.

describe('tokens.ts requireSession gate (threat model mitigation 11)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  test('POST /tokens rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'origin',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'pwn', scopes: ['documents:write'] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('POST /tokens rejects bearer + garbage cookie with 403 (symmetry with ai.ts)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'cookie-bypass',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    for (const garbageCookie of [
      'folio_session=garbage',
      'folio_session=',
      'folio_session=expired-id',
    ]) {
      const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: garbageCookie,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: 'pwn', scopes: ['documents:write'] }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    }
  });

  test('DELETE /tokens/:tokenId rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    // Mint a peer token to attempt revoking.
    const peerId = nanoid();
    await db.insert(apiTokens).values({
      id: peerId,
      workspaceId: seed.workspace.id,
      name: 'peer',
      tokenHash: 'peer-hash',
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    // Mint the attacker token used for the bearer.
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'attacker',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${tokensPath(seed.workspace.slug, seed.workspace.id)}/${peerId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('DELETE /tokens/:tokenId rejects bearer + garbage cookie with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const peerId = nanoid();
    await db.insert(apiTokens).values({
      id: peerId,
      workspaceId: seed.workspace.id,
      name: 'peer',
      tokenHash: 'peer-hash',
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'attacker',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${tokensPath(seed.workspace.slug, seed.workspace.id)}/${peerId}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: 'folio_session=garbage',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // Happy path — session caller can still POST + DELETE.
  test('POST /tokens succeeds for a session caller', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: {
        Cookie: seed.sessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'ci', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.name).toBe('ci');
  });
});
