import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { slugify, ErrorCode } from '@folio/shared';
import { useCreateWorkspace } from '../../lib/api/workspaces.ts';
import { ApiError, apiErrorCode, formatApiError } from '../../lib/api/index.ts';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '../ui/sheet.tsx';
import { Button } from '../ui/button.tsx';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Provider = 'none' | 'anthropic' | 'openai' | 'openrouter' | 'ollama';

export function WorkspaceCreate({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const create = useCreateWorkspace();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [provider, setProvider] = useState<Provider>('none');
  const [slugError, setSlugError] = useState<string | null>(null);

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  useEffect(() => {
    if (!open) {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setProvider('none');
      setSlugError(null);
    }
  }, [open]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSlugError(null);
    try {
      const ws = await create.mutateAsync({ name: name.trim(), slug });
      onOpenChange(false);
      void navigate({ to: '/w/$wslug', params: { wslug: ws.slug } });
    } catch (err) {
      if (err instanceof ApiError && apiErrorCode(err) === ErrorCode.SLUG_CONFLICT) {
        setSlugError(formatApiError(err));
        return;
      }
      toast.error(formatApiError(err));
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width={460}>
        <SheetHeader>
          <SheetTitle>New workspace</SheetTitle>
        </SheetHeader>
        <form className="flex flex-col flex-1 overflow-y-auto" onSubmit={onSubmit}>
          <div className="mt-6 space-y-4 px-6">
            <div>
              <label htmlFor="ws-name" className="block text-sm font-medium text-fg">
                Name
              </label>
              <input
                id="ws-name"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg focus:outline-none focus-visible:border-fg-3 focus-visible:bg-card"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="ws-slug" className="block text-sm font-medium text-fg">
                Slug
              </label>
              <input
                id="ws-slug"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 font-mono text-sm text-fg focus:outline-none focus-visible:border-fg-3 focus-visible:bg-card"
                value={slug}
                onChange={(e) => {
                  setSlug(slugify(e.target.value));
                  setSlugTouched(true);
                }}
                pattern="[a-z0-9-]+"
                required
              />
              {slugError && (
                <div className="mt-1 text-sm text-danger" role="alert">
                  {slugError}
                </div>
              )}
            </div>
            <div>
              <label htmlFor="ws-provider" className="block text-sm font-medium text-fg">
                AI provider
              </label>
              <select
                id="ws-provider"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg focus:outline-none focus-visible:border-fg-3 focus-visible:bg-card"
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
              >
                <option value="none">None (configure later)</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama">Ollama (self-host)</option>
              </select>
              <p className="mt-1 text-xs text-fg-3">API key entry lands in Phase 3.</p>
            </div>
          </div>
          <SheetFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !slug}>
              {create.isPending ? 'Creating…' : 'Create workspace'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
