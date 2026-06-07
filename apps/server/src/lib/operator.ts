/**
 * Phase 4 (drop-workspace-tenancy), Task 16 — the operator as a runtime singleton.
 *
 * OQ-1 (d): the operator is resolved from CODE, never a `documents` row. Its
 * identity is unspoofable two ways:
 *   1. OPERATOR_SLUG is `_`-prefixed → `isReservedSlug` blocks a user creating an
 *      agent with this slug (defense in depth at the create surface).
 *   2. The agent resolver (Task 17) returns THIS code singleton for the operator
 *      slug, never a queried row — so even a row that somehow bore the slug can
 *      never BE the operator.
 *
 * The prompt + tool whitelist are the same constants the old seeded operator used
 * (re-exported from system-skills.ts), so there is one source of truth.
 */

import type { Document } from '../db/schema.ts';
import {
  FOLIO_SKILL_SLUG,
  OPERATOR_PROMPT,
  OPERATOR_TOOLS,
} from './system-skills.ts';

/**
 * The operator's reserved slug. `_`-prefixed so `isReservedSlug` (which blocks
 * any `_`-prefixed slug) makes it unspawnable by users with zero extra logic.
 */
export const OPERATOR_SLUG = '_operator';

/**
 * The operator's synthetic DOCUMENT id — the stable, non-colliding id returned by
 * `getOperatorDocument().id`. The operator is a CODE SINGLETON with NO `documents`
 * row, so this is never a real FK value.
 *
 * Shape B′ (2026-06-07): this id is NO LONGER stamped on any token. The operator's
 * ephemeral token carries `agentId: null` + the un-forgeable `isOperator` marker
 * (see `EphemeralToken` in schema.ts). The old FK-null-hack in `dispatchAsCaller`
 * is gone — there is no longer a persistence path that would try to write this id.
 *
 * Its ONLY remaining job is author attribution: `resolveAuthorContextForToken`
 * reads `getOperatorDocument().id` so the operator's authored comments/events get a
 * stable, non-null author string. It is never an `api_tokens.agent_id` FK value.
 *
 * NAME KEPT (not renamed to OPERATOR_DOC_ID): two test files import it precisely as
 * "the old sentinel value" to assert the FK back-door stays closed
 * (agent-tools.test.ts, conversation-runs.test.ts) — renaming would muddy that
 * intent. The docstring above is the source of truth on what it now means.
 */
export const OPERATOR_AGENT_ID = `operator:${OPERATOR_SLUG}`;

// The operator's DEFAULT model + provider — overridden at runtime by the
// `operator_model` instance setting (Settings → AI "Use for operator", via
// getOperatorModelSetting/resolveOperatorRunModel); these back getOperatorDefinition()
// only when no setting row exists. NOTE (2026-06-06): small local models tested
// via Ollama (qwen2.5-coder 7b/14b, llama3.1:8b) do NOT reliably drive the
// operator's structured tool calls — the autonomous flow needs a tool-call-capable
// model. See memory.
export const OPERATOR_MODEL = 'claude-sonnet-4-6';
export const OPERATOR_PROVIDER = 'anthropic';

export interface OperatorDefinition {
  slug: string;
  prompt: string;
  tools: readonly string[];
  skills: readonly string[];
  model: string;
  provider: string;
  /** The operator may act on any project (subject to the caller ceiling). */
  projects: readonly string[];
}

/** True iff `slug` names the operator singleton. */
export function isOperator(slug: string): boolean {
  return slug === OPERATOR_SLUG;
}

/**
 * The operator's definition, materialized from code. Stable across calls; the
 * resolver returns this for `isOperator(slug)` rather than a row.
 */
export function getOperatorDefinition(): OperatorDefinition {
  return {
    slug: OPERATOR_SLUG,
    prompt: OPERATOR_PROMPT,
    tools: OPERATOR_TOOLS,
    skills: [FOLIO_SKILL_SLUG],
    model: OPERATOR_MODEL,
    provider: OPERATOR_PROVIDER,
    projects: ['*'],
  };
}

/**
 * The operator as a synthetic, agent-shaped `Document` — the single place that
 * owns both the operator's definition AND its Document shape, so a new field on
 * OperatorDefinition can't silently drift from the materialized row. NOT
 * persisted: `id`/`workspaceId` are sentinels (the operator has no row and no
 * token; its run path is cockpit-gated and refused at createRun). The resolver
 * returns this for the operator slug so trigger/mention resolution +
 * anti-impersonation hold without ever reading a `documents` row.
 */
export function getOperatorDocument(): Document {
  const def = getOperatorDefinition();
  return {
    id: OPERATOR_AGENT_ID,
    workspaceId: '',
    projectId: null,
    tableId: null,
    parentId: null,
    type: 'agent',
    slug: def.slug,
    title: def.slug,
    status: null,
    body: def.prompt,
    frontmatter: {
      provider: def.provider,
      model: def.model,
      tools: [...def.tools],
      skills: [...def.skills],
      projects: [...def.projects],
      requires_approval: false,
    },
    boardPosition: null,
    createdBy: null,
    updatedBy: null,
    lastTouchedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as Document;
}
