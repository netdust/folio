import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';
import { useCreateToken } from '../../lib/api/tokens.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { toast } from 'sonner';

const ALL_SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  'fields:write',
  'views:write',
  'tables:write',
] as const;

type Scope = (typeof ALL_SCOPES)[number];

interface Props {
  wslug: string;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TokenCreateModal({ wslug, workspaceId, open, onOpenChange }: Props) {
  const create = useCreateToken(wslug, workspaceId);
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
            <DialogTitle>Create API token</DialogTitle>
            <DialogDescription>
              Tokens authenticate agents and external integrations. Scopes are enforced
              on every write.
            </DialogDescription>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="block text-xs font-medium text-fg-2">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. CI bot"
                  className="mt-1 block w-full rounded-md border border-border-light bg-content px-2 py-1.5 text-sm"
                />
              </label>

              <fieldset>
                <legend className="text-xs font-medium text-fg-2">Scopes</legend>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
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
