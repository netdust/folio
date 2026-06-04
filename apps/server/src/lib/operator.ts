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

/** The operator's model + provider — unchanged from the seeded-agent era. */
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
 * resolver (Task 17) returns this for `isOperator(slug)` rather than a row.
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
