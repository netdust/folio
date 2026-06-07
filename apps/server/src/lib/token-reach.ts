import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import { apiTokens, type ApiToken, type EphemeralToken } from '../db/schema.ts';
import type { Role } from './access.ts';
import { roleToScopes } from './agent-schema.ts';
import { newApiToken } from './auth.ts';
import { HTTPError } from './http.ts';

/** A token with null workspaceId reaches every workspace (instance-wide). */
export function isInstanceReach(token: Pick<ApiToken, 'workspaceId'>): boolean {
  return token.workspaceId === null;
}

/**
 * The system-origin OPERATOR token: instance reach + system origin (createdBy
 * null) — code-provisioned for the operator, never mintable via POST
 * /tokens (which always stamps a human createdBy). This is the SINGLE named
 * definition of "the user-less operator principal"; consumers that branch on
 * "no hydrated user ⟹ act as the instance" (e.g. workspace-create owner
 * resolution) check this rather than re-inferring it from `createdBy === null`
 * scattered across files. A human-minted instance PAT has createdBy set, so it
 * is NOT an operator token — it hydrates a real user and never takes the
 * operator fallback path.
 */
export function isOperatorToken(
  token: Pick<ApiToken, 'workspaceId' | 'createdBy'>,
): boolean {
  return token.workspaceId === null && token.createdBy === null;
}

/**
 * True iff this token acts as an AGENT (its own allow-list/identity governs the
 * authority decision), vs a human PAT (the human creator's grants govern). The
 * operator is agent-bound but carries NO agentId (Shape B′: no FK sentinel) — it
 * is identified by the explicit `isOperator` marker on its ephemeral token
 * (createConversationRun only; NOT a DB column). A human PAT has no marker, so it
 * is NOT agent-bound. THE single discriminator for every "agent path vs human
 * path" branch — replacing scattered `if (token.agentId)` checks, which
 * mis-classify the operator once its agentId is null.
 * NOTE: keyed on `isOperator`, NOT `isOperatorToken` (the createdBy-based helper)
 * — the operator's createdBy is the CALLER (non-null), so isOperatorToken is false
 * for it. The two are unrelated.
 */
export function isAgentBound(
  token: Pick<EphemeralToken, 'agentId' | 'isOperator'>,
): boolean {
  return token.agentId !== null || token.isOperator === true;
}

export type EffectiveReach =
  | { ok: true; workspaceId: string | null }
  | { ok: false };

/**
 * The per-run workspace floor: tokenReach ∩ callerReach.
 *  - null  = instance (any workspace)
 *  - id    = pinned to that workspace
 * Intersection rules:
 *  - null ∩ X      = X     (instance token narrowed to the caller's reach)
 *  - id  ∩ null    = id    (a pinned token's caller is unbounded → keep the pin)
 *  - id  ∩ same id = id
 *  - id  ∩ other   = DENY  (a pinned token cannot reach outside its pin)
 */
export function effectiveReach(
  tokenReach: string | null,
  callerReach: string | null,
): EffectiveReach {
  if (tokenReach === null) return { ok: true, workspaceId: callerReach };
  if (callerReach === null || callerReach === tokenReach) {
    return { ok: true, workspaceId: tokenReach };
  }
  return { ok: false };
}

/** An api_token row with the secret hash removed, safe to return over HTTP. */
export type PublicApiToken = Omit<ApiToken, 'tokenHash'>;

/**
 * The SINGLE redacting serializer for api_token rows on any listing surface
 * (CR#7 — "redact at the loader, not the handler"). Strips `tokenHash` so a new
 * token-listing route cannot leak the secret by re-implementing the strip.
 * Route both the per-workspace list and the instance-token list through this.
 */
export function serializeApiToken({ tokenHash: _omit, ...rest }: ApiToken): PublicApiToken {
  return rest;
}

/** The plaintext-bearing result of a mint — returned to the caller EXACTLY ONCE. */
export interface MintedToken {
  id: string;
  name: string;
  token: string;
  scopes: string[];
  instance: boolean;
}

/**
 * THE single token-mint convergence point. Both POST surfaces (per-workspace
 * `tokens.ts` and instance `instance-tokens.ts`) route through here so the scope
 * ceiling + insert + reveal-once shape can never drift apart — a past CRITICAL
 * (privilege escalation, 9f75c40) was a mint path that skipped the ceiling.
 *
 * The ceiling: a caller may only mint scopes their OWN instance role already
 * grants (`roleToScopes` — the same ceiling the runner enforces at execution
 * time). `reach` is the token's workspace_id (null = instance-wide); the caller's
 * authority to choose that reach is decided by the ROUTE before calling this
 * (a per-ws route passes the URL workspace; the instance route requires admin
 * and passes null). Throws FORBIDDEN_SCOPE (403) on an over-scope request.
 */
export async function mintToken(
  db: DB,
  args: {
    ceilingRole: Role;
    scopes: string[];
    reach: string | null;
    name: string;
    createdBy: string;
    /** Optional lifetime in days; omitted/undefined ⟹ a never-expiring token. */
    expiresInDays?: number;
  },
): Promise<MintedToken> {
  const allowed = roleToScopes(args.ceilingRole);
  const over = args.scopes.filter((s) => !allowed.includes(s));
  if (over.length > 0) {
    throw new HTTPError(
      'FORBIDDEN_SCOPE',
      `role '${args.ceilingRole}' cannot mint a token with scope(s): ${over.join(', ')}`,
      403,
    );
  }
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id,
    workspaceId: args.reach,
    name: args.name,
    tokenHash: hash,
    scopes: args.scopes,
    createdBy: args.createdBy,
    expiresAt:
      args.expiresInDays != null ? new Date(Date.now() + args.expiresInDays * 86_400_000) : null,
  });
  return { id, name: args.name, token, scopes: args.scopes, instance: args.reach === null };
}
