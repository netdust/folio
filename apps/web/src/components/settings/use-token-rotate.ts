import { useState } from 'react';
import { toast } from 'sonner';
import type { ApiToken } from '../../lib/api/tokens.ts';
import { formatApiError } from '../../lib/api/index.ts';

/** The mint mutation a tab passes in — returns the once-only plaintext token. */
interface CreateMutation {
  mutateAsync: (vars: {
    name: string;
    scopes: string[];
    expires_in_days?: number;
  }) => Promise<{ token: string }>;
}

/** The revoke mutation a tab passes in — deletes by token id. */
interface DeleteMutation {
  mutateAsync: (tokenId: string) => Promise<unknown>;
}

interface Args {
  createToken: CreateMutation;
  deleteToken: DeleteMutation;
}

/**
 * Shared token-rotate flow behind BOTH the per-workspace TokensTab and the
 * instance InstanceTokensTab. Owns the rotate state + the create-then-delete
 * ordering; the ONLY difference between the two tabs is which mutations they
 * mint/revoke through, so those are injected.
 *
 * Rotate = mint a new token FIRST (same name + scopes), then revoke the old one
 * only after the new mint succeeds. Ordering matters for safety: if the mint
 * fails the old token is still valid (nothing lost); if the revoke fails after a
 * successful mint the worst case is two live tokens — the user has the new secret
 * and can revoke the old one manually, which is strictly safer than being left
 * with zero tokens.
 *
 * (Extracted from two byte-identical copies — the exact "duplication springs a
 * leak" shape this codebase has been bitten by; the rotate logic now lives once.)
 */
export function useTokenRotate({ createToken, deleteToken }: Args) {
  const [pendingRotate, setPendingRotate] = useState<ApiToken | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

  async function confirmRotate() {
    if (!pendingRotate) return;
    const target = pendingRotate;
    setRotating(true);
    // The token row carries only the absolute expiresAt, not the original day
    // window. Approximate it: keep the rotated token alive for the days
    // remaining until the original expiry (floored at 1). Null = forever, omit.
    const expires_in_days =
      target.expiresAt !== null
        ? Math.max(1, Math.ceil((Date.parse(target.expiresAt) - Date.now()) / 86_400_000))
        : undefined;
    let minted = false;
    try {
      const res = await createToken.mutateAsync({
        name: target.name,
        scopes: target.scopes,
        ...(expires_in_days !== undefined ? { expires_in_days } : {}),
      });
      minted = true;
      await deleteToken.mutateAsync(target.id);
      setRotatedSecret(res.token);
      setPendingRotate(null);
    } catch (err) {
      // Close the dialog so it can't reference a token whose state is now
      // ambiguous, and tell the user exactly which step failed.
      setPendingRotate(null);
      toast.error(
        minted
          ? `New token created but the old one could not be revoked — revoke "${target.name}" manually. (${formatApiError(err)})`
          : `Rotation failed; your existing token is unchanged. (${formatApiError(err)})`,
      );
    } finally {
      setRotating(false);
    }
  }

  return {
    pendingRotate,
    setPendingRotate,
    rotating,
    rotatedSecret,
    setRotatedSecret,
    confirmRotate,
  };
}
