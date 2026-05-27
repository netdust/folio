/**
 * Phase 2.6 sub-phase D — Builtin triggers.
 *
 * Every workspace is born with 4 builtin triggers that wire up the agent
 * lifecycle (assignment dispatch, @mention dispatch, approval / rejection
 * resume-reject). They are server-locked: only `frontmatter.enabled` is
 * mutable, and they cannot be deleted (see `services/documents.ts`
 * BUILTIN_TRIGGER_LOCKED).
 *
 * The shape is intentionally minimal — `seedBuiltinTriggers` writes directly
 * to the `documents` table, bypassing the API-layer schema validation in
 * `trigger-schema.ts`. The seeded frontmatter still satisfies that schema, so
 * subsequent PATCH/POST operations through the API layer will validate
 * cleanly against builtin docs.
 *
 * Per the plan: this helper is reused by D4's backfill script for instances
 * created before Phase 2.6 sub-phase D shipped.
 */

import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { emitEvent } from './events.ts';

type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

interface BuiltinTriggerDef {
  slug: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

export const BUILTIN_TRIGGER_DEFS: ReadonlyArray<BuiltinTriggerDef> = [
  {
    slug: 'builtin-on-assignment',
    title: 'Run agent on assignment',
    frontmatter: {
      on_event: 'agent.task.assigned',
      schedule: null,
      // F12: emitters of agent.task.assigned write payload.agent (the slug),
      // not payload.assignee_slug. Placeholder must match the actual key —
      // otherwise the Phase 3 dispatcher will resolve to undefined and the
      // trigger silently never fires.
      agent: '$event.agent',
      enabled: false,
      builtin: true,
      payload: null,
    },
  },
  {
    slug: 'builtin-on-mention',
    title: 'Run agent on @mention',
    frontmatter: {
      on_event: 'comment.mentioned',
      schedule: null,
      agent: '$event.agent_slug',
      enabled: false,
      builtin: true,
      payload: null,
    },
  },
  {
    slug: 'builtin-on-approval',
    title: 'Resume agent run on approval',
    frontmatter: {
      on_event: 'comment.created',
      schedule: null,
      event_filter: { kind: 'approval' },
      agent: null,
      internal_action: 'resume_run',
      enabled: true,
      builtin: true,
    },
  },
  {
    slug: 'builtin-on-rejection',
    title: 'Reject agent run on rejection',
    frontmatter: {
      on_event: 'comment.created',
      schedule: null,
      event_filter: { kind: 'rejection' },
      agent: null,
      internal_action: 'reject_run',
      enabled: true,
      builtin: true,
    },
  },
];

/**
 * Seed builtin triggers for a workspace. Caller controls the transaction.
 *
 * No-ops on conflict (uniqueness is enforced by the
 * `documents_workspace_type_slug_idx` index), but callers are responsible for
 * only calling this when not already seeded. D4's backfill script guards
 * against re-seeding by checking existing builtin slugs first.
 *
 * B2: emits one `document.created` event per inserted row. The wedge says
 * "every write emits an event" — agents subscribing to `document.created`
 * with type=trigger SHOULD see the four builtins arrive at workspace birth.
 * The previous "workspace.created covers it" rationale was wrong: subscribers
 * filter by event kind, and the workspace.created event doesn't carry the
 * trigger metadata an agent needs to react.
 */
export async function seedBuiltinTriggers(
  tx: DBOrTx,
  workspaceId: string,
  actor: string,
): Promise<void> {
  for (const def of BUILTIN_TRIGGER_DEFS) {
    const id = nanoid();
    await tx.insert(documents).values({
      id,
      workspaceId,
      projectId: null,
      type: 'trigger',
      slug: def.slug,
      title: def.title,
      body: '',
      frontmatter: def.frontmatter,
    });
    await emitEvent(tx, {
      workspaceId,
      projectId: null,
      documentId: id,
      kind: 'document.created',
      actor,
      payload: { slug: def.slug, type: 'trigger', builtin: true },
    });
  }
}
