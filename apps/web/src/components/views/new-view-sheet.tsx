import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useCreateView, type ViewCreate } from '../../lib/api/views.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '../ui/sheet.tsx';
import { Button } from '../ui/button.tsx';

export interface NewViewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wslug: string;
  pslug: string;
  // Required: the sheet copy ("Captures the current filters, sort, and
  // columns.") makes this a contract. If the caller has no filter context to
  // capture, pass `{}` explicitly rather than letting it default — that
  // intentionality prevents silent loss of URL state at the call site.
  currentSearch: Record<string, unknown>;
  // V2 (views UX shake-out): the active view's current columns, so the new view
  // CAPTURES them (the copy promises "the current … columns"). Omit / undefined
  // when there's no active view → the server defaults the columns. A null inside
  // means "no explicit column state on the active view" → also omitted.
  currentColumns?: { visibleFields: string[] | null; columnOrder: string[] | null };
}

const FILTER_KEYS = ['status', 'priority', 'assignee', 'labels', 'updated_since'] as const;

export function NewViewSheet({
  open,
  onOpenChange,
  wslug,
  pslug,
  currentSearch,
  currentColumns,
}: NewViewSheetProps) {
  const navigate = useNavigate();
  const create = useCreateView(wslug, pslug);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!open) setName('');
  }, [open]);

  function buildPayload(): ViewCreate {
    const trimmed = name.trim();
    const src = currentSearch;
    const filters: Record<string, unknown> = {};
    for (const key of FILTER_KEYS) {
      const v = src[key];
      if (v !== undefined && v !== null && v !== '') {
        filters[key] = v;
      }
    }
    const sortKey = src.sort;
    const sortDir = src.dir;
    const sort =
      typeof sortKey === 'string' && sortKey
        ? [{ key: sortKey, dir: sortDir === 'desc' ? 'desc' : 'asc' }]
        : [];
    const payload: ViewCreate = { name: trimmed, type: 'list', filters, sort };
    // V2: capture the current columns so the new view starts as a copy of what the
    // user is looking at (the sheet copy's promise). Only include keys that have a
    // value — a null on the active view means "no explicit column state", so we
    // omit it and let the server default rather than persist an empty/null.
    if (currentColumns?.visibleFields != null) payload.visibleFields = currentColumns.visibleFields;
    if (currentColumns?.columnOrder != null) payload.columnOrder = currentColumns.columnOrder;
    return payload;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const view = await create.mutateAsync(buildPayload());
      onOpenChange(false);
      toast.success('View created');
      void navigate({
        to: '/w/$wslug/p/$pslug/work-items',
        params: { wslug, pslug },
        search: { view: view.id },
      });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width={420}>
        <SheetHeader>
          <SheetTitle>New view</SheetTitle>
        </SheetHeader>
        <form className="flex flex-1 flex-col overflow-y-auto" onSubmit={onSubmit}>
          <div className="mt-6 space-y-4 px-6">
            <div>
              <label htmlFor="view-name" className="block text-sm font-medium text-fg">
                Name
              </label>
              <input
                id="view-name"
                className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg input-focus"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
                autoFocus
              />
              <p className="mt-1.5 text-xs text-fg-3">
                Captures the current filters, sort, and columns. Future changes auto-save.
              </p>
            </div>
          </div>
          <SheetFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Creating…' : 'Create view'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
