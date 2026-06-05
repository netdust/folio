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

// Scopes an instance token can carry. Mirrors the workspace token modal, plus
// the admin scopes that only make sense instance-wide (workspace:admin lets the
// holder create workspaces; settings/members:write administer the instance).
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
type Scope = (typeof ALL_SCOPES)[number];

const PRESETS: { label: string; scopes: Scope[]; tone?: 'default' | 'danger' }[] = [
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

function relativeOrAbsolute(iso: string | null): string {
  if (!iso) return 'Never used';
  const seconds = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Instance (reach=null) API tokens — cross-workspace tokens for operator/admin
 * automation: create workspaces, change settings, manage agents across the whole
 * instance. Distinct from the per-workspace API tokens on the Agents & Triggers →
 * API tab. Owner/admin only (the server gates create/list/revoke).
 */
export function InstanceTokensTab() {
  const tokensQuery = useInstanceTokens();
  const deleteToken = useDeleteInstanceToken();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ApiToken | null>(null);

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
              <div className="text-xs text-fg-3">{relativeOrAbsolute(t.lastUsedAt)}</div>
              <Button variant="ghost" size="sm" onClick={() => setPendingRevoke(t)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <InstanceTokenCreateModal open={createOpen} onOpenChange={setCreateOpen} />

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
    </div>
  );
}

function InstanceTokenCreateModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateInstanceToken();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<Scope>>(new Set());
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canSubmit = name.trim().length > 0 && scopes.size > 0 && !create.isPending;

  function reset() {
    setName('');
    setScopes(new Set());
    setRevealed(null);
    setCopied(false);
  }
  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function onSubmit() {
    if (!canSubmit) return;
    try {
      const res = await create.mutateAsync({ name: name.trim(), scopes: Array.from(scopes) });
      setRevealed(res.token);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  }

  async function onCopy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the token manually');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {revealed === null ? (
          <>
            <DialogTitle>Create instance token</DialogTitle>
            <DialogDescription>
              This token reaches every workspace. Scopes are enforced on every write.
            </DialogDescription>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="block text-xs font-medium text-fg-2">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. operator"
                  className="mt-1 block w-full rounded-md border border-border-light bg-content px-2 py-1.5 text-sm"
                />
              </label>

              <fieldset>
                <legend className="text-xs font-medium text-fg-2">Scopes</legend>
                <div className="mt-1 mb-2 flex flex-wrap gap-1.5">
                  {PRESETS.map((preset) => {
                    const isDanger = preset.tone === 'danger';
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        data-tone={preset.tone ?? 'default'}
                        onClick={() => setScopes(new Set(preset.scopes))}
                        className={
                          isDanger
                            ? 'rounded-sm border border-danger/40 bg-bg-danger px-2 py-0.5 text-[11px] text-danger hover:bg-danger hover:text-fg-on-primary'
                            : 'rounded-sm bg-card px-2 py-0.5 text-[11px] text-fg-2 hover:bg-shell hover:text-fg'
                        }
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {ALL_SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={scope}
                        checked={scopes.has(scope)}
                        onChange={(e) => {
                          setScopes((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(scope);
                            else next.delete(scope);
                            return next;
                          });
                        }}
                      />
                      <span className="font-mono text-xs">{scope}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={onSubmit} disabled={!canSubmit} loading={create.isPending}>
                Create
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>Token created</DialogTitle>
            <DialogDescription>
              This is the only time you&apos;ll see this token. Copy it now and store it
              somewhere safe.
            </DialogDescription>
            <div className="mt-4 rounded-md border border-border-light bg-shell p-2">
              <code className="block break-all font-mono text-xs text-fg">{revealed}</code>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" onClick={onCopy}>
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
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
