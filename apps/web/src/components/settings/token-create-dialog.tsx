import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';
import { formatApiError } from '../../lib/api/index.ts';

export interface ScopePreset {
  label: string;
  scopes: string[];
  tone?: 'default' | 'danger';
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title in the create state, e.g. "Create API token". */
  title: string;
  /** One-line description under the title. */
  description: string;
  /** Full scope list offered as checkboxes. */
  allScopes: readonly string[];
  /** Preset buttons that set the scope selection. */
  presets: ScopePreset[];
  /** Optional warning shown when ALL scopes are selected (root-access alert). */
  allScopesWarning?: string;
  /**
   * The create mutation — returns the once-only plaintext token. `expires_in_days`
   * is omitted entirely when the expiry field is left blank (never expires).
   */
  mutate: (vars: {
    name: string;
    scopes: string[];
    expires_in_days?: number;
  }) => Promise<{ token: string }>;
  isPending: boolean;
}

/**
 * Shared token-create dialog: name + scope-picker (presets + checkboxes) → mint →
 * reveal-once + copy. The single implementation behind BOTH the per-workspace
 * TokenCreateModal and the instance InstanceTokensTab modal; they differ only in
 * the scope list, presets, copy, and which mutation they pass. (Before this, the
 * reveal/copy flow was duplicated per-consumer — the exact shape that leaked a
 * secret once by drifting between copies.)
 */
export function TokenCreateDialog({
  open,
  onOpenChange,
  title,
  description,
  allScopes,
  presets,
  allScopesWarning,
  mutate,
  isPending,
}: Props) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expiresInDays, setExpiresInDays] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canSubmit = name.trim().length > 0 && scopes.size > 0 && !isPending;

  function reset() {
    setName('');
    setScopes(new Set());
    setExpiresInDays('');
    setRevealed(null);
    setCopied(false);
  }
  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function onSubmit() {
    if (!canSubmit) return;
    // Blank/empty/non-positive = never expires → omit the key entirely so the
    // server stores a null expiresAt.
    const trimmed = expiresInDays.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    const expires_in_days =
      parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    try {
      const res = await mutate({
        name: name.trim(),
        scopes: Array.from(scopes),
        ...(expires_in_days !== undefined ? { expires_in_days } : {}),
      });
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
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>

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
                <div className="mt-1 mb-2 flex flex-wrap gap-1.5">
                  {presets.map((preset) => {
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
                {allScopesWarning && scopes.size === allScopes.length ? (
                  <div
                    role="alert"
                    className="mb-2 rounded-sm border border-danger/40 bg-bg-danger px-2 py-1.5 text-[11px] text-danger"
                  >
                    {allScopesWarning}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {allScopes.map((scope) => (
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

              <label className="block">
                <span className="block text-xs font-medium text-fg-2">
                  Expires in (days)
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  placeholder="Leave blank to never expire"
                  className="mt-1 block w-full rounded-md border border-border-light bg-content px-2 py-1.5 text-sm"
                />
                <span className="mt-1 block text-[11px] text-fg-3">
                  Blank = never expires. The token is rejected after this many days.
                </span>
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={onSubmit} disabled={!canSubmit} loading={isPending}>
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
