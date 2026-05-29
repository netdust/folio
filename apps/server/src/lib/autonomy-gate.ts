/**
 * Phase 3 Sub-phase D — shared autonomy-gate emitter (Finding 2, altitude).
 *
 * The autonomy gate (mitigation 54 / 51) decision — "an agent-originated chain
 * hop with `FOLIO_AGENT_CHAINS_ENABLED` OFF creates ZERO runs and emits exactly
 * one durable `agent.chain.suppressed`" — is enforced at FIVE call sites: the
 * trigger-matcher, `POST /runs` create, the `run_agent` MCP tool, and both
 * retry faces (`POST /runs/:id/retry`, `retry_run` MCP tool).
 *
 * Each call site keeps its OWN `if (agentOriginated && !env.FOLIO_AGENT_CHAINS_
 * ENABLED)` decision plus its transport-specific throw (HTTP 403
 * `AGENT_CHAINS_DISABLED` vs MCP `mcpInvalidParams`). What was copy-pasted — and
 * is now defined exactly ONCE here — is the EVENT SHAPE: kind
 * `agent.chain.suppressed`, payload `{ agent_slug, reason: 'autonomy_gate' }`.
 */

import type { DB } from '../db/client.ts';
import { emitEvent, txWithEvents } from './events.ts';

export interface ChainSuppressedArgs {
  workspaceId: string;
  /** Parent's project id, or null when the parent has no project. */
  projectId: string | null;
  /** The parent work_item/page the suppressed chain hop targeted. */
  documentId: string;
  /** Bare slug of the agent whose chain hop was suppressed. */
  agentSlug: string;
  /** Event actor — the agent token id / agent identity that originated the hop. */
  actor: string;
}

/**
 * Emit the canonical `agent.chain.suppressed` event in its own committed
 * transaction. One definition of the event shape for every gate call site.
 */
export async function emitChainSuppressed(db: DB, args: ChainSuppressedArgs): Promise<void> {
  await txWithEvents(db, async (tx) => {
    await emitEvent(tx, {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      documentId: args.documentId,
      kind: 'agent.chain.suppressed',
      actor: args.actor,
      payload: { agent_slug: args.agentSlug, reason: 'autonomy_gate' },
    });
  });
}
