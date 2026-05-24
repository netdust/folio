import { useEffect, useState, type FormEvent } from 'react';
import { slugify, ErrorCode } from '@folio/shared';
import { useCreateTable } from '../../lib/api/tables.ts';
import { ApiError, apiErrorCode, formatApiError } from '../../lib/api/index.ts';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '../ui/sheet.tsx';
import { Button } from '../ui/button.tsx';
import { toast } from 'sonner';

interface Props {
  wslug: string;
  pslug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TableCreate({ wslug, pslug, open, onOpenChange }: Props) {
  const create = useCreateTable(wslug, pslug);

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

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSlugError(null);
    try {
      await create.mutateAsync({ name: name.trim(), slug });
      onOpenChange(false);
      toast.success('Table created');
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
          <SheetTitle>New table</SheetTitle>
        </SheetHeader>
        <form className="flex flex-col flex-1 overflow-y-auto" onSubmit={onSubmit}>
          <div className="mt-6 space-y-4 px-6">
            <div>
              <label htmlFor="table-name" className="block text-sm font-medium text-fg">
                Name
              </label>
              <input
                id="table-name"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg input-focus"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="table-slug" className="block text-sm font-medium text-fg">
                Slug
              </label>
              <input
                id="table-slug"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 font-mono text-sm text-fg input-focus"
                value={slug}
                onChange={(e) => {
                  setSlug(slugify(e.target.value));
                  setSlugTouched(true);
                }}
                pattern="[a-z0-9-]+"
                maxLength={64}
                required
              />
              <p className="mt-1.5 text-xs text-fg-3">
                Used in URLs. Can't be changed after the table is created.
              </p>
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
