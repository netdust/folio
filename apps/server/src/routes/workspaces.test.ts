import { expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { documents } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';

test('GET /api/v1/workspaces lists user workspaces', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0].workspace.slug).toBe('acme');
  expect(body.data[0].role).toBe('owner');
});

test('GET /api/v1/workspaces 401 without cookie', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces');
  expect(res.status).toBe(401);
});

test('POST /api/v1/workspaces creates with derived slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Place' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.slug).toMatch(/^new-place/);
});

test('POST /api/v1/workspaces auto-seeds 4 builtin triggers', async () => {
  const { app, seed, db } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Co', slug: 'newco' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();

  const triggers = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, body.data.id), eq(documents.type, 'trigger')));

  const slugs = triggers.map((t) => t.slug).sort();
  expect(slugs).toEqual([
    'builtin-on-approval',
    'builtin-on-assignment',
    'builtin-on-mention',
    'builtin-on-rejection',
  ]);

  // All 4 are marked builtin: true.
  for (const t of triggers) {
    const fm = t.frontmatter as Record<string, unknown>;
    expect(fm.builtin).toBe(true);
  }

  // Enabled defaults per spec §6f.
  const byslug = Object.fromEntries(triggers.map((t) => [t.slug, t]));
  expect((byslug['builtin-on-assignment']!.frontmatter as Record<string, unknown>).enabled).toBe(false);
  expect((byslug['builtin-on-mention']!.frontmatter as Record<string, unknown>).enabled).toBe(false);
  expect((byslug['builtin-on-approval']!.frontmatter as Record<string, unknown>).enabled).toBe(true);
  expect((byslug['builtin-on-rejection']!.frontmatter as Record<string, unknown>).enabled).toBe(true);

  // projectId is null (workspace-scoped).
  for (const t of triggers) {
    expect(t.projectId).toBeNull();
  }
});

test('POST with explicit slug; second use is 409', async () => {
  const { app, seed } = await makeTestApp();
  await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Foo', slug: 'taken' }),
  });
  const dupe = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bar', slug: 'taken' }),
  });
  expect(dupe.status).toBe(409);
  expect((await dupe.json()).error.code).toBe('SLUG_CONFLICT');
});

test('GET /api/v1/workspaces/:wslug returns workspace + role', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.slug).toBe('acme');
  expect(body.data.role).toBe('owner');
});

test('PATCH /api/v1/workspaces/:wslug renames (owner)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme', {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Acme Inc' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.name).toBe('Acme Inc');
});

test('DELETE /api/v1/workspaces/:wslug 204 (owner)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme', {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('GET /api/v1/w/:wslug/members returns id/name/email/role for each membership', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/members', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { members: { id: string; email: string; name: string; role: string }[] };
  };
  expect(Array.isArray(body.data.members)).toBe(true);
  expect(body.data.members.length).toBe(1);
  const m = body.data.members[0]!;
  expect(m.id).toBe(seed.user.id);
  expect(m.email).toBe('alice@test.local');
  expect(m.role).toBe('owner');
});

test('GET /api/v1/w/:wslug/members 401 without auth', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/members');
  expect(res.status).toBe(401);
});
