/**
 * Tests for the D4 backfill script.
 *
 * The harness inserts the 'acme' workspace via `db.insert(workspaces)` directly
 * (bypassing the POST /workspaces route), so the seeded workspace has ZERO
 * builtin triggers — exactly the pre-2.6 condition this script is designed to
 * restore. That's why every test calls `seedBuiltinTriggers` manually when it
 * needs the post-create baseline.
 */

import { describe, it, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { documents, events } from '../apps/server/src/db/schema.ts';
import { makeTestApp } from '../apps/server/src/test/harness.ts';
import { backfillBuiltinTriggers } from './backfill-builtin-triggers.ts';
import { BUILTIN_TRIGGER_DEFS, seedBuiltinTriggers } from '../apps/server/src/lib/builtin-triggers.ts';
import { eventBus } from '../apps/server/src/lib/event-bus.ts';
import type { DB } from '../apps/server/src/db/client.ts';

describe('backfillBuiltinTriggers', () => {
  it('no-ops when a workspace already has all 4 builtins', async () => {
    const { db, seed } = await makeTestApp();
    // Seed the 4 builtins manually so this test exercises the no-op path.
    await db.transaction(async (tx) => {
      await seedBuiltinTriggers(tx, seed.workspace.id, seed.user.id);
    });

    const result = await backfillBuiltinTriggers(db);
    expect(result.workspacesTouched).toBe(0);
    expect(result.documentsInserted).toBe(0);
    expect(result.perWorkspace).toEqual([]);
  });

  it('inserts all 4 missing builtins for a bare workspace', async () => {
    const { db, seed } = await makeTestApp();
    // 'acme' has zero builtins (harness bypasses the route).
    const result = await backfillBuiltinTriggers(db);
    expect(result.workspacesTouched).toBe(1);
    expect(result.documentsInserted).toBe(4);
    expect(result.perWorkspace).toHaveLength(1);
    expect(result.perWorkspace[0]!.workspaceId).toBe(seed.workspace.id);
    expect(result.perWorkspace[0]!.insertedSlugs.sort()).toEqual([
      'builtin-on-approval',
      'builtin-on-assignment',
      'builtin-on-mention',
      'builtin-on-rejection',
    ]);

    // Verify the rows actually exist.
    const rows = await db
      .select()
      .from(documents)
      .where(and(eq(documents.workspaceId, seed.workspace.id), eq(documents.type, 'trigger')));
    expect(rows).toHaveLength(4);
  });

  it('inserts only the missing builtins when some are already present', async () => {
    const { db, seed } = await makeTestApp();
    // Manually insert 2 of the 4.
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      projectId: null,
      type: 'trigger',
      slug: 'builtin-on-approval',
      title: 'Resume agent run on approval',
      body: '',
      frontmatter: BUILTIN_TRIGGER_DEFS.find((d) => d.slug === 'builtin-on-approval')!.frontmatter,
    });
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      projectId: null,
      type: 'trigger',
      slug: 'builtin-on-assignment',
      title: 'Run agent on assignment',
      body: '',
      frontmatter: BUILTIN_TRIGGER_DEFS.find((d) => d.slug === 'builtin-on-assignment')!.frontmatter,
    });

    const result = await backfillBuiltinTriggers(db);
    expect(result.workspacesTouched).toBe(1);
    expect(result.documentsInserted).toBe(2);
    expect(result.perWorkspace).toHaveLength(1);
    expect(result.perWorkspace[0]!.insertedSlugs.sort()).toEqual([
      'builtin-on-mention',
      'builtin-on-rejection',
    ]);
  });

  it('emits one document.created event per insert', async () => {
    const { db, seed } = await makeTestApp();

    const eventsBefore = await db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, seed.workspace.id), eq(events.kind, 'document.created')));

    await backfillBuiltinTriggers(db);

    const eventsAfter = await db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, seed.workspace.id), eq(events.kind, 'document.created')));

    expect(eventsAfter.length - eventsBefore.length).toBe(4);
    // Actor stamped consistently with the default.
    const new4 = eventsAfter.slice(-4);
    for (const ev of new4) {
      expect(ev.actor).toBe('system:backfill');
    }
  });

  it('is idempotent — second run after a successful first run is a no-op', async () => {
    const { db } = await makeTestApp();
    const first = await backfillBuiltinTriggers(db);
    expect(first.workspacesTouched).toBe(1);
    expect(first.documentsInserted).toBe(4);

    const second = await backfillBuiltinTriggers(db);
    expect(second.workspacesTouched).toBe(0);
    expect(second.documentsInserted).toBe(0);
    expect(second.perWorkspace).toEqual([]);
  });

  it('honors a custom actor', async () => {
    const { db, seed } = await makeTestApp();
    await backfillBuiltinTriggers(db, { actor: 'cli:stefan' });
    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, seed.workspace.id), eq(events.kind, 'document.created')));
    const last4 = eventRows.slice(-4);
    expect(last4).toHaveLength(4);
    for (const ev of last4) {
      expect(ev.actor).toBe('cli:stefan');
    }
  });

  // BUG-008 — the loop must run inside txWithEvents so a mid-loop throw
  // suppresses ALL bus publishes for the rolled-back inserts. With the old
  // raw `db.transaction`, emitEvent's fallback fires eventBus.publish
  // immediately and ghost trigger events reach live subscribers even though
  // the rows never persist.
  it('publishes zero bus events when the loop throws mid-flight (BUG-008)', async () => {
    const { db, seed } = await makeTestApp();

    const published: Array<{ kind: string; documentId?: string | null }> = [];
    const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
      published.push({ kind: e.kind, documentId: e.documentId });
    });

    // Wrap db so its tx.insert(documents) throws on the 3rd call. The first
    // two inserts would (before the fix) publish their events immediately;
    // the throw rolls back the SQL rows but live subscribers still saw them.
    let insertCount = 0;
    const wrappedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async (
            fn: (tx: Parameters<Parameters<DB['transaction']>[0]>[0]) => Promise<unknown>,
          ) => {
            return target.transaction(async (tx) => {
              const wrappedTx = new Proxy(tx, {
                get(t, p, r) {
                  if (p === 'insert') {
                    return (table: unknown) => {
                      insertCount += 1;
                      if (insertCount === 3) {
                        throw new Error('synthetic mid-loop failure');
                      }
                      return (t as { insert: (x: unknown) => unknown }).insert(table);
                    };
                  }
                  return Reflect.get(t, p, r);
                },
              });
              return fn(wrappedTx);
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as DB;

    let threw = false;
    try {
      await backfillBuiltinTriggers(wrappedDb);
    } catch {
      threw = true;
    }
    unsub();

    expect(threw).toBe(true);
    // The fix: bus publishes only happen after a successful tx commit.
    // No commit means no publishes. The 1st and 2nd document.created events
    // (which the old code already published before the 3rd insert threw)
    // must not have reached the bus.
    expect(published.filter((e) => e.kind === 'document.created')).toEqual([]);
    // Sanity: nothing else slipped through either.
    expect(published).toEqual([]);
  });
});
