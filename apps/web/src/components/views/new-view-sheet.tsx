import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useCreateView, type ViewCreate } from '../../lib/api/views.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { resolveViewNav } from '../../lib/rail-nav.ts';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '../ui/sheet.tsx';
import { Button } from '../ui/button.tsx';

export interface NewViewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wslug: string;
  pslug: string;
  // C3T9: the table the view is created on. The rail captures the real tslug
  // when "+ new view" is clicked under a specific table; the sheet creates and
  // routes on it (default table → legacy /work-items|/board, others → /t/$tslug).
  tslug: string;
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
  tslug,
  currentSearch,
  currentColumns,
}: NewViewSheetProps) {
  const navigate = useNavigate();
  const create = useCreateView(wslug, pslug, tslug);
  // Fields for the ACTIVE table populate the Kanban group-by options (same
  // source as BoardToolbar), so they must come from the table the view is being
  // created on — not a hardcoded work-items literal.
  const { data: fields } = useFields(wslug, pslug, tslug);
  const [name, setName] = useState('');
  const [type, setType] = useState<'list' | 'kanban'>('list');
  // Group-by for kanban. 'status' is the default; selecting it stores null on
  // the view per the "defaults to status" convention (see board-controls).
  const [groupBy, setGroupBy] = useState('status');

  useEffect(() => {
    if (!open) {
      setName('');
      setType('list');
      setGroupBy('status');
    }
  }, [open]);

  // BoardToolbar excludes multi_select fields from grouping; mirror that here so
  // the offered options match what the board can actually group by.
  const groupableFields = (fields ?? []).filter((f) => f.type !== 'multi_select');

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
    const payload: ViewCreate = { name: trimmed, type, filters, sort };
    // 4a: a kanban view carries its group-by. 'status' is the default and is
    // stored as null (the "defaults to status" convention from board-controls);
    // a field key is stored verbatim. A list view omits groupBy entirely.
    if (type === 'kanban') {
      payload.groupBy = groupBy === 'status' ? null : groupBy;
    }
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
      // C3T9: route to the CAPTURED table via the single rail-nav resolver (the
      // same source w.$wslug.tsx's onViewClick uses). Default table → legacy
      // /work-items|/board (no param); other tables → /t/$tslug(/board).
      const target = resolveViewNav(tslug, view.type);
      void navigate({
        to: target.to,
        params: target.withTslug ? { wslug, pslug, tslug } : { wslug, pslug },
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

            <fieldset>
              <legend className="block text-sm font-medium text-fg">Type</legend>
              <div className="mt-1 flex gap-4">
                <label className="flex items-center gap-2 text-sm text-fg-1">
                  <input
                    type="radio"
                    name="view-type"
                    value="list"
                    checked={type === 'list'}
                    onChange={() => setType('list')}
                  />
                  List
                </label>
                <label className="flex items-center gap-2 text-sm text-fg-1">
                  <input
                    type="radio"
                    name="view-type"
                    value="kanban"
                    checked={type === 'kanban'}
                    onChange={() => setType('kanban')}
                  />
                  Kanban
                </label>
              </div>
            </fieldset>

            {type === 'kanban' && (
              <div>
                <label htmlFor="view-group-by" className="block text-sm font-medium text-fg">
                  Group by
                </label>
                <select
                  id="view-group-by"
                  className="mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg input-focus"
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                >
                  <option value="status">Status</option>
                  {groupableFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label ?? f.key}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
