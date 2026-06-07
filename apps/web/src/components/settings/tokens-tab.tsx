import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  type ApiToken,
  useCreateToken,
  useDeleteToken,
  useTokens,
} from '../../lib/api/tokens.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Button } from '../ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';
import { TokenCreateModal } from './token-create-modal.tsx';
import { lastUsedLabel, expiresLabel } from './token-meta.ts';

interface Props {
  wslug: string;
  workspaceId: string;
}

export function TokensTab({ wslug, workspaceId }: Props) {
  const tokensQuery = useTokens(wslug, workspaceId);
  const createToken = useCreateToken(wslug, workspaceId);
  const deleteToken = useDeleteToken(wslug, workspaceId);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ApiToken | null>(null);
  const [pendingRotate, setPendingRotate] = useState<ApiToken | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tokens = tokensQuery.data ?? [];

  async function confirmRevoke() {
    if (!pendingRevoke) return;
    try {
      await deleteToken.mutateAsync(pendingRevoke.id);
      toast.success(`Revoked "${pendingRevoke.name}"`);
      setPendingRevoke(null);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  }

  // Rotate = mint a new token FIRST (same name + scopes), then revoke the old
  // one only after the new mint succeeds. Ordering matters for safety: if the
  // mint fails the old token is still valid (nothing lost); if the revoke fails
  // after a successful mint the worst case is two live tokens — the user has the
  // new secret and can revoke the old one manually, which is strictly safer than
  // being left with zero tokens.
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

  async function copySecret() {
    if (!rotatedSecret) return;
    try {
      await navigator.clipboard.writeText(rotatedSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the token manually');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-medium">API tokens</h2>
          <p className="mt-0.5 text-xs text-fg-2">
            Tokens authenticate agents, MCP clients, and external integrations against
            this workspace.
          </p>
        </div>
        {tokens.length > 0 ? (
          <Button onClick={() => setCreateOpen(true)}>+ Create token</Button>
        ) : null}
      </div>

      {tokensQuery.isLoading ? (
        <div className="text-sm text-fg-2">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="rounded-md border border-border-light bg-shell p-6 text-center">
          <p className="text-sm text-fg-2">No API tokens yet.</p>
          <p className="mt-1 text-xs text-fg-3">
            Create one to let an agent or MCP client talk to this workspace.
          </p>
          <div className="mt-4">
            <Button onClick={() => setCreateOpen(true)}>+ Create token</Button>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border-light rounded-md border border-border-light bg-shell">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-4 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] font-mono text-fg-3">
                  {t.scopes.map((s) => (
                    <span
                      key={s}
                      className="rounded-sm bg-card px-1.5 py-0.5"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <div className="text-right text-xs text-fg-3">
                <div>{expiresLabel(t.expiresAt)}</div>
                <div>{lastUsedLabel(t.lastUsedAt)}</div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingRotate(t)}
              >
                Rotate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingRevoke(t)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <TokenCreateModal
        wslug={wslug}
        workspaceId={workspaceId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <Dialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Revoke &quot;{pendingRevoke?.name}&quot;?</DialogTitle>
          <DialogDescription>
            Any agent or client using this token will immediately lose access. This
            cannot be undone.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingRevoke(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmRevoke}
              loading={deleteToken.isPending}
            >
              Revoke
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRotate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRotate(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Rotate &quot;{pendingRotate?.name}&quot;?</DialogTitle>
          <DialogDescription>
            This issues a new secret with the same name and scopes, then revokes
            the current one. Anything using the old token loses access immediately.
            If the old token had an expiry, the new one keeps a comparable window.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingRotate(null)}>
              Cancel
            </Button>
            <Button onClick={confirmRotate} loading={rotating}>
              Rotate
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={rotatedSecret !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRotatedSecret(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Token rotated</DialogTitle>
          <DialogDescription>
            This is the only time you&apos;ll see this token. Copy it now and store it
            somewhere safe.
          </DialogDescription>
          <div className="mt-4 rounded-md border border-border-light bg-shell p-2">
            <code className="block break-all font-mono text-xs text-fg">
              {rotatedSecret}
            </code>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={copySecret}>
              {copied ? (
                <>
                  <Check size={14} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={14} />
                  Copy
                </>
              )}
            </Button>
            <Button
              onClick={() => {
                setRotatedSecret(null);
                setCopied(false);
              }}
            >
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
