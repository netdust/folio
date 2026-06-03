import type { ApiToken } from '../db/schema.ts';

/** A token with null workspaceId reaches every workspace (instance-wide). */
export function isInstanceReach(token: Pick<ApiToken, 'workspaceId'>): boolean {
  return token.workspaceId === null;
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
