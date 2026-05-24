import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { slugify, ErrorCode } from '@folio/shared';
import { useCreateProject } from '../../lib/api/projects.ts';
import { ApiError, apiErrorCode, formatApiError } from '../../lib/api/index.ts';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '../ui/sheet.tsx';
import { Button } from '../ui/button.tsx';
import { toast } from 'sonner';

interface Props {
  wslug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectCreate({ wslug, open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const create = useCreateProject(wslug);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  useEffect(() => {
    if (!open) {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setSlugError(null);
    }
  }, [open]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSlugError(null);
    try {
      const project = await create.mutateAsync({ name: name.trim(), slug });
      onOpenChange(false);
      void navigate({
        to: '/w/$wslug/p/$pslug/work-items',
        params: { wslug, pslug: project.slug },
      });
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
          <SheetTitle>New project</SheetTitle>
        </SheetHeader>
        <form className="flex flex-col flex-1 overflow-y-auto" onSubmit={onSubmit}>
          <div className="mt-6 space-y-4 px-6">
            <div>
              <label htmlFor="proj-name" className="block text-sm font-medium text-fg">
                Name
              </label>
              <input
                id="proj-name"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg input-focus"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="proj-slug" className="block text-sm font-medium text-fg">
                Slug
              </label>
              <input
                id="proj-slug"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 font-mono text-sm text-fg input-focus"
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
          </div>
          <SheetFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !slug}>
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
