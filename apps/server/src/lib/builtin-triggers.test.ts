/**
 * Builtin-trigger placeholder alignment tests.
 *
 * F12 — placeholders like `$event.agent` / `$event.agent_slug` in builtin
 * trigger frontmatter MUST match the actual payload keys the emitters write.
 * Drift here means the Phase 3 dispatcher resolves the placeholder to
 * undefined and the trigger silently never fires.
 */
import { test, expect } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { events, workspaces, workspaceAccess } from '../db/schema.ts';
import { emitEvent, txWithEvents } from './events.ts';
import { BUILTIN_TRIGGER_DEFS, seedBuiltinTriggers } from './builtin-triggers.ts';
import { nanoid } from 'nanoid';

/** Extract the payload key referenced by a `$event.<key>` placeholder. */
function placeholderKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^\$event\.([a-z_][a-z0-9_]*)$/i);
  return m ? (m[1] ?? null) : null;
}

test('F12: builtin-on-assignment $event.agent placeholder matches actual agent.task.assigned payload', async () => {
  const { db, seed } = await makeTestApp();

  // Emit one of the actual events the assignment paths produce.
  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    kind: 'agent.task.assigned',
    actor: seed.user.id,
    payload: { slug: 'task-1', agent: 'drafter' },
  });
  const [row] = await db
    .select()
    .from(events)
    .where(eq(events.kind, 'agent.task.assigned'));
  expect(row).toBeTruthy();
  const payload = row!.payload as Record<string, unknown>;

  const builtin = BUILTIN_TRIGGER_DEFS.find((t) => t.slug === 'builtin-on-assignment');
  expect(builtin).toBeTruthy();
  const placeholder = builtin!.frontmatter['agent'];
  const key = placeholderKey(placeholder);
  expect(key).toBe('agent');
  // The key referenced by the placeholder MUST exist on the payload.
  expect(payload).toHaveProperty(key as string);
  expect(payload[key as string]).toBe('drafter');
});

test('B2: seedBuiltinTriggers emits a document.created event per inserted row', async () => {
  // Bypass makeTestApp's pre-seeded workspace so we can seed cleanly.
  const { db, seed } = await makeTestApp();
  const wsId = nanoid();
  await db.insert(workspaces).values({ id: wsId, slug: `ws-b2-${wsId.slice(0, 6)}`, name: 'ws-b2' });
  // seed.user is the instance owner (users.role='owner', set by the harness); a
  // workspace_access grant gives explicit visibility to this fresh workspace.
  await db.insert(workspaceAccess).values({ userId: seed.user.id, workspaceId: wsId });

  await txWithEvents(db, async (tx) => {
    await seedBuiltinTriggers(tx, wsId, seed.user.id);
  });

  const seededSlugs = BUILTIN_TRIGGER_DEFS.map((d) => d.slug);
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, wsId), eq(events.kind, 'document.created')));
  expect(rows.length).toBe(seededSlugs.length);
  for (const r of rows) {
    const payload = r.payload as Record<string, unknown>;
    expect(seededSlugs).toContain(payload['slug'] as string);
    expect(payload['type']).toBe('trigger');
    expect(payload['builtin']).toBe(true);
  }
});

test('F12: builtin-on-mention $event.agent_slug placeholder matches actual comment.mentioned payload', async () => {
  const { db, seed } = await makeTestApp();

  await emitEvent(db, {
    workspaceId: seed.workspace.id,
    kind: 'comment.mentioned',
    actor: seed.user.id,
    payload: { comment_id: 'c-1', parent_id: 'doc-1', agent_slug: 'drafter' },
  });
  const [row] = await db
    .select()
    .from(events)
    .where(eq(events.kind, 'comment.mentioned'));
  const payload = row!.payload as Record<string, unknown>;

  const builtin = BUILTIN_TRIGGER_DEFS.find((t) => t.slug === 'builtin-on-mention');
  const placeholder = builtin!.frontmatter['agent'];
  const key = placeholderKey(placeholder);
  expect(key).toBe('agent_slug');
  expect(payload).toHaveProperty(key as string);
  expect(payload[key as string]).toBe('drafter');
});
