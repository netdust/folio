/**
 * Phase 2.6 sub-phase E — Allow-list reconciler.
 *
 * Background safety net for agent `frontmatter.projects` allow-lists. The
 * project-delete cascade hook is the primary cleanup mechanism; this reconciler
 * is insurance against:
 *   - bugs in the cascade hook,
 *   - hand-edited markdown imports with orphan ids,
 *   - partial restores from backup where projects + agents drift.
 *
 * Behavior:
 *   - Iterates every document with `type='agent'`.
 *   - Skips wildcard allow-lists (`projects: ['*']`) and missing/empty lists.
 *   - Skips malformed frontmatter (non-string entries) — defensive; logging
 *     malformed shapes is out of scope here.
 *   - For explicit id lists, queries `projects` for the workspace and removes
 *     any ids that no longer resolve. Rewrites the agent's frontmatter and
 *     emits `agent.allow_list.reconciled` inside a single transaction.
 *   - Emits one event per scrubbed agent. The bus event is the primary signal
 *     for SSE subscribers; the event row is the durable backstop.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { documents, projects } from '../db/schema.ts';
import { emitEvent, txWithEvents } from './events.ts';

export interface ReconcileOptions {
  onEvent?: (event: {
    kind: 'agent.allow_list.reconciled';
    agentId: string;
    removed: string[];
  }) => void;
  /** Override actor for emitted events. Default 'system:reconciler'. */
  actor?: string;
}

export interface ReconcileResult {
  agentsTouched: number;
  totalRemoved: number;
}

export async function reconcileAllowLists(
  db: DB,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const actor = opts.actor ?? 'system:reconciler';

  const agents = await db
    .select()
    .from(documents)
    .where(eq(documents.type, 'agent'));

  let agentsTouched = 0;
  let totalRemoved = 0;

  for (const agent of agents) {
    const fm = (agent.frontmatter ?? {}) as Record<string, unknown>;
    const ids = fm.projects;
    if (!Array.isArray(ids) || ids.length === 0) continue;
    // Wildcard short-circuit. ['*'] means "all projects", nothing to scrub.
    if (ids[0] === '*') continue;
    // Defensive: malformed frontmatter shouldn't crash the reconciler. Skip
    // any agent whose projects array isn't all strings.
    if (!ids.every((x) => typeof x === 'string')) continue;
    const idStrs = ids as string[];

    // Which of these ids still resolve in this workspace? Workspace-scoping
    // matters: project ids are workspace-unique so a stray id from another
    // workspace also counts as an orphan.
    const live = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, agent.workspaceId), inArray(projects.id, idStrs)));
    const liveSet = new Set(live.map((p) => p.id));
    const filtered = idStrs.filter((id) => liveSet.has(id));
    const removed = idStrs.filter((id) => !liveSet.has(id));
    if (removed.length === 0) continue;

    await txWithEvents(db, async (tx) => {
      await tx
        .update(documents)
        .set({
          frontmatter: { ...fm, projects: filtered },
          updatedAt: new Date(),
        })
        .where(eq(documents.id, agent.id));
      await emitEvent(tx, {
        workspaceId: agent.workspaceId,
        projectId: null,
        documentId: agent.id,
        kind: 'agent.allow_list.reconciled',
        actor,
        payload: {
          agent_id: agent.id,
          removed_project_ids: removed,
        },
      });
    });

    agentsTouched += 1;
    totalRemoved += removed.length;
    opts.onEvent?.({
      kind: 'agent.allow_list.reconciled',
      agentId: agent.id,
      removed,
    });
  }

  if (agentsTouched > 0) {
    console.log(
      `reconciler: scrubbed ${agentsTouched} agents (${totalRemoved} orphan ids removed)`,
    );
  }
  return { agentsTouched, totalRemoved };
}
