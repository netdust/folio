#!/usr/bin/env bun
/**
 * Backfill builtin triggers for pre-2.6 workspaces.
 *
 * Sub-phase D3 auto-seeds the 4 builtin triggers when a workspace is created.
 * Workspaces created before 2.6 don't have them. This script restores them.
 *
 * Idempotent: re-runs no-op once all 4 builtins are present per workspace.
 * Matches by slug — won't re-insert if an operator created a doc with the
 * same slug (the existing doc wins, even if its frontmatter differs).
 *
 * Emits `document.created` events per insert (decision: spec §9). Agents
 * subscribed to the SSE bus may react to the restoration. Slower than raw
 * SQL but consistent with the rest of the system.
 *
 * Usage:
 *   bun run scripts/backfill-builtin-triggers.ts
 */

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DB } from '../apps/server/src/db/client.ts';
import { documents, workspaces } from '../apps/server/src/db/schema.ts';
import { emitEvent } from '../apps/server/src/lib/events.ts';
import { BUILTIN_TRIGGER_DEFS } from '../apps/server/src/lib/builtin-triggers.ts';

export interface BackfillResult {
  workspacesTouched: number;
  documentsInserted: number;
  perWorkspace: Array<{ workspaceId: string; insertedSlugs: string[] }>;
}

export interface BackfillOptions {
  /** Actor stamped on the emitted `document.created` events. */
  actor?: string;
}

export async function backfillBuiltinTriggers(
  db: DB,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const actor = opts.actor ?? 'system:backfill';
  const builtinSlugs = BUILTIN_TRIGGER_DEFS.map((d) => d.slug);

  const allWorkspaces = await db.select().from(workspaces);

  let workspacesTouched = 0;
  let documentsInserted = 0;
  const perWorkspace: BackfillResult['perWorkspace'] = [];

  for (const ws of allWorkspaces) {
    // Pull this workspace's existing trigger slugs and filter in JS — the
    // workspace has few triggers, so this is simpler than SQLite's
    // JSON_EXTRACT for the builtin flag.
    const existing = await db
      .select({ slug: documents.slug })
      .from(documents)
      .where(and(eq(documents.workspaceId, ws.id), eq(documents.type, 'trigger')));
    const existingSlugs = new Set(existing.map((r) => r.slug));

    // Match by slug only, restricting to the 4 known builtin slugs — won't be
    // confused by operator-created triggers with arbitrary slugs.
    const missing = BUILTIN_TRIGGER_DEFS.filter(
      (def) => builtinSlugs.includes(def.slug) && !existingSlugs.has(def.slug),
    );

    if (missing.length === 0) continue;

    const insertedSlugs: string[] = [];
    await db.transaction(async (tx) => {
      for (const def of missing) {
        const id = nanoid();
        await tx.insert(documents).values({
          id,
          workspaceId: ws.id,
          projectId: null,
          type: 'trigger',
          slug: def.slug,
          title: def.title,
          body: '',
          frontmatter: def.frontmatter,
        });
        await emitEvent(tx, {
          workspaceId: ws.id,
          projectId: null,
          documentId: id,
          kind: 'document.created',
          actor,
          payload: { slug: def.slug, type: 'trigger' },
        });
        insertedSlugs.push(def.slug);
      }
    });

    workspacesTouched += 1;
    documentsInserted += insertedSlugs.length;
    perWorkspace.push({ workspaceId: ws.id, insertedSlugs });
  }

  return { workspacesTouched, documentsInserted, perWorkspace };
}

if (import.meta.main) {
  const { db } = await import('../apps/server/src/db/client.ts');
  const result = await backfillBuiltinTriggers(db);
  console.log(
    `Backfill complete. Touched ${result.workspacesTouched} workspaces, inserted ${result.documentsInserted} triggers.`,
  );
  for (const ws of result.perWorkspace) {
    console.log(`  ${ws.workspaceId}: ${ws.insertedSlugs.join(', ')}`);
  }
  process.exit(0);
}
