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
  currentSearch?: Record<string, unknown>;
}

const FILTER_KEYS = ['status', 'priority', 'assignee', 'labels', 'updated_since'] as const;

export function NewViewSheet({ open, onOpenChange, wslug, pslug, currentSearch }: NewViewSheetProps) {
  const navigate = useNavigate();
  const create = useCreateView(wslug, pslug);
  const [name, setName] = useState('');
  const [useCurrent, setUseCurrent] = useState(true);

  useEffect(() => {
    if (!open) {
      setName('');
      setUseCurrent(true);
    }
  }, [open]);

  function buildPayload(): ViewCreate {
    const trimmed = name.trim();
    if (!useCurrent) {
      return { name: trimmed, type: 'list', filters: {}, sort: [] };
    }
    const src = currentSearch ?? {};
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
    return { name: trimmed, type: 'list', filters, sort };
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
        // TODO Task 7: declare `view?: string` on the work-items route's
        // validateSearch schema, then drop this cast.
        search: { view: view.id } as unknown as Record<string, never>,
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
            </div>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={useCurrent}
                onChange={(e) => setUseCurrent(e.target.checked)}
              />
              Use current filters, sort, and columns
            </label>
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
