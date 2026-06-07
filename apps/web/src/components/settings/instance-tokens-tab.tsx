import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  type ApiToken,
  useCreateInstanceToken,
  useDeleteInstanceToken,
  useInstanceTokens,
} from '../../lib/api/tokens.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Button } from '../ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';
import { TokenCreateDialog, type ScopePreset } from './token-create-dialog.tsx';
import { lastUsedLabel, expiresLabel } from './token-meta.ts';

// Scopes an instance token can carry — the per-workspace set plus the admin
// scopes that only make sense instance-wide (workspace:admin lets the holder
// create workspaces; settings/members:write administer the instance).
const ALL_SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  'config:write',
  'agents:write',
  'settings:write',
  'members:write',
  'workspace:admin',
] as const;

const PRESETS: ScopePreset[] = [
  { label: 'Read-only', scopes: ['documents:read'] },
  { label: 'Read + write', scopes: ['documents:read', 'documents:write', 'config:write'] },
  {
    label: 'Operator',
    tone: 'danger',
    scopes: [
      'documents:read',
      'documents:write',
      'documents:delete',
      'config:write',
      'agents:write',
      'settings:write',
      'members:write',
      'workspace:admin',
    ],
  },
];

/**
 * Instance (reach=null) API tokens — cross-workspace tokens for operator/admin
 * automation: create workspaces, change settings, manage agents across the whole
 * instance. Distinct from the per-workspace API tokens on the Agents & Triggers →
 * API tab. Owner/admin only (the server gates create/list/revoke).
 */
export function InstanceTokensTab() {
  const tokensQuery = useInstanceTokens();
  const createToken = useCreateInstanceToken();
  const deleteToken = useDeleteInstanceToken();
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

  // Rotate = revoke old + mint new (same name + scopes), reveal the new secret
  // once. The original expiry window can't be recomputed from the stored
  // absolute expiresAt, so a rotated instance token defaults to never-expires.
  async function confirmRotate() {
    if (!pendingRotate) return;
    const target = pendingRotate;
    setRotating(true);
    try {
      await deleteToken.mutateAsync(target.id);
      const res = await createToken.mutateAsync({
        name: target.name,
        scopes: target.scopes,
      });
      setRotatedSecret(res.token);
      setPendingRotate(null);
    } catch (err) {
      toast.error(formatApiError(err));
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
          <h2 className="text-sm font-medium">Instance API tokens</h2>
          <p className="mt-0.5 text-xs text-fg-2">
            Cross-workspace tokens for operator/admin automation — create workspaces,
            change settings, manage agents across the whole instance.
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
          <p className="text-sm text-fg-2">No instance tokens yet.</p>
          <p className="mt-1 text-xs text-fg-3">
            Create one to let the operator / an automation act across every workspace.
          </p>
          <div className="mt-4">
            <Button onClick={() => setCreateOpen(true)}>+ Create token</Button>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border-light rounded-md border border-border-light bg-shell">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] font-mono text-fg-3">
                  {t.scopes.map((s) => (
                    <span key={s} className="rounded-sm bg-card px-1.5 py-0.5">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <div className="text-right text-xs text-fg-3">
                <div>{expiresLabel(t.expiresAt)}</div>
                <div>{lastUsedLabel(t.lastUsedAt)}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPendingRotate(t)}>
                Rotate
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPendingRevoke(t)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <TokenCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create instance token"
        description="This token reaches every workspace. Scopes are enforced on every write."
        allScopes={ALL_SCOPES}
        presets={PRESETS}
        mutate={(vars) => createToken.mutateAsync(vars)}
        isPending={createToken.isPending}
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
            Any client using this token will immediately lose access across every
            workspace. This cannot be undone.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingRevoke(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRevoke} loading={deleteToken.isPending}>
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
            This revokes the current secret and issues a new one with the same name
            and scopes across every workspace. Anything using the old token loses
            access immediately. The rotated token does not carry over an expiry.
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
