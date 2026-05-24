import { useState } from 'react';
import { toast } from 'sonner';
import { useUpdateView, type View } from '../../lib/api/views.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Button } from '../ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';
import type { FilterClauseUrl } from '../../lib/api/documents.ts';

export interface SaveFiltersActionProps {
  wslug: string;
  pslug: string;
  view: View;
  clauses: FilterClauseUrl[];
  onSaved?: () => void;
}

const URL_FILTER_KEYS = ['status', 'priority', 'labels', 'assignee', 'updated_since'] as const;
const ARRAY_KEYS = new Set(['status', 'labels']);

// Build the flat-shape filter object from URL clauses — matches what the New
// View sheet writes, so saved filters stay consistent across both entry points.
function clausesToFlatFilters(clauses: FilterClauseUrl[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of clauses) {
    if (c.kind === 'status') out.status = c.values;
    else if (c.kind === 'priority') out.priority = c.value;
    else if (c.kind === 'labels') out.labels = c.values;
    else if (c.kind === 'assignee') out.assignee = c.value;
    else if (c.kind === 'updated_since') out.updated_since = c.value;
  }
  return out;
}

// Normalize a view's stored filters down to the flat shape. The hydration in
// TableView accepts both flat (`{status: 'X'}`) and AST (`{status: {$eq: 'X'}}`)
// shapes; the seeded defaults use AST. We collapse both into the same flat
// representation so equality holds whichever way the view was created.
// Only extracts keys that can appear in the URL (status, priority, labels, assignee, updated_since).
function normalizeViewFilters(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const key of URL_FILTER_KEYS) {
    const val = (raw as Record<string, unknown>)[key];
    if (val === null || val === undefined || val === '') continue;
    // Flat shape: string / number / array
    if (typeof val === 'string' || typeof val === 'number') {
      out[key] = ARRAY_KEYS.has(key) ? [String(val)] : val;
      continue;
    }
    if (Array.isArray(val)) {
      out[key] = ARRAY_KEYS.has(key) ? val : val[0];
      continue;
    }
    if (typeof val === 'object') {
      const op = val as Record<string, unknown>;
      if ('$eq' in op && op['$eq'] !== undefined) {
        const v = op['$eq'];
        out[key] = ARRAY_KEYS.has(key) ? [String(v)] : v;
      } else if ('$in' in op && Array.isArray(op['$in'])) {
        out[key] = ARRAY_KEYS.has(key) ? op['$in'] : op['$in'][0];
      }
    }
  }
  return out;
}

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys.map((k) => [k, obj[k]]));
}

/** True iff the URL clauses represent the same filter set as the view's saved filters. */
export function filtersEqual(urlClauses: FilterClauseUrl[], viewFilters: unknown): boolean {
  const url = clausesToFlatFilters(urlClauses);
  const view = normalizeViewFilters(viewFilters);
  return stableStringify(url) === stableStringify(view);
}

export function SaveFiltersAction({
  wslug,
  pslug,
  view,
  clauses,
  onSaved,
}: SaveFiltersActionProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const update = useUpdateView(wslug, pslug);

  if (filtersEqual(clauses, view.filters)) return null;

  const onConfirm = async () => {
    try {
      await update.mutateAsync({
        id: view.id,
        patch: { filters: clausesToFlatFilters(clauses) },
      });
      setConfirmOpen(false);
      toast.success('Filters saved to view');
      onSaved?.();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-fg-3 transition-colors duration-fast hover:bg-card hover:text-fg-2"
      >
        Save filters
      </button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogTitle>Save filters to &ldquo;{view.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            This will overwrite the view&rsquo;s saved filters.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={onConfirm} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save filters'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
