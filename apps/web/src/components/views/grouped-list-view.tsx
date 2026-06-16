import type { GroupedListSettings } from '@folio/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { type DocumentSummary, useDocuments } from '../../lib/api/documents.ts';
import { useFields } from '../../lib/api/fields.ts';
import { useGroupSummary } from '../../lib/api/group-summary.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { EmptyState } from './empty-state.tsx';
import { GroupAggregateHeader } from './group-aggregate-header.tsx';
import { GroupedListRow } from './grouped-list-row.tsx';
import { GroupedListSkeleton } from './grouped-list-skeleton.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

const PAGE_LIMIT = 50;
const NO_GROUP_KEY = '__nogroup__';

const DEFAULT_SETTINGS: GroupedListSettings = {
  groupBy: 'status',
  aggregates: [{ op: 'count' }],
  rowLayout: { primary: 'title', fields: [] },
};

/** Read the active view's `settings` as GroupedListSettings, with safe defaults. */
function resolveSettings(settings: Record<string, unknown> | undefined): GroupedListSettings {
  if (!settings || typeof settings !== 'object') return DEFAULT_SETTINGS;
  const s = settings as Partial<GroupedListSettings>;
  return {
    groupBy: typeof s.groupBy === 'string' && s.groupBy ? s.groupBy : DEFAULT_SETTINGS.groupBy,
    aggregates:
      Array.isArray(s.aggregates) && s.aggregates.length > 0
        ? s.aggregates
        : DEFAULT_SETTINGS.aggregates,
    rowLayout:
      s.rowLayout && typeof s.rowLayout === 'object' && typeof s.rowLayout.primary === 'string'
        ? {
            primary: s.rowLayout.primary,
            subtitle: s.rowLayout.subtitle,
            fields: s.rowLayout.fields ?? [],
          }
        : DEFAULT_SETTINGS.rowLayout,
  };
}

/** The group value a loaded row falls under (for DISPLAY placement only). */
function rowGroupValue(doc: DocumentSummary, groupBy: string): string | null {
  const raw =
    groupBy === 'status' ? doc.status : (doc.frontmatter as Record<string, unknown>)[groupBy];
  if (raw === null || raw === undefined || raw === '') return null;
  return String(raw);
}

/**
 * The grouped-list view (Phase 6 Cluster 2b). Group HEADERS (counts + aggregates)
 * come from `useGroupSummary` (the full-set endpoint); ROWS come from a paginated
 * `useDocuments`. Loaded rows are bucketed client-side ONLY to decide which
 * section they render under — never to compute a header total (the page-2 guard).
 */
export function GroupedListView({ wslug, pslug, tslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;

  const { view, isLoading: viewLoading } = useActiveView(wslug, pslug, tslug);
  const settings = useMemo(() => resolveSettings(view?.settings), [view]);
  const { data: fields } = useFields(wslug, pslug, tslug);

  // The SAME filter feeds both queries so headers and rows stay consistent. Read
  // it off the URL search (mirrors list-view); full FilterBar wiring is L.4/L.5.
  const filter = useMemo(() => {
    const f = search.filter;
    return f && typeof f === 'object' ? (f as Record<string, unknown>) : undefined;
  }, [search.filter]);

  const summary = useGroupSummary(wslug, pslug, tslug, {
    groupBy: settings.groupBy,
    aggregates: settings.aggregates,
    filter,
    type: 'work_item',
  });

  const {
    data: page,
    isLoading: docsLoading,
    error: docsError,
  } = useDocuments(wslug, pslug, tslug, {
    type: 'work_item',
    limit: PAGE_LIMIT,
    filter,
  });

  // Bucket loaded rows by their group value — DISPLAY placement only.
  const rowsByGroup = useMemo(() => {
    const map = new Map<string | null, DocumentSummary[]>();
    for (const doc of page?.data ?? []) {
      const key = rowGroupValue(doc, settings.groupBy);
      const existing = map.get(key);
      if (existing) existing.push(doc);
      else map.set(key, [doc]);
    }
    return map;
  }, [page, settings.groupBy]);

  const loading = viewLoading || summary.isLoading || docsLoading;
  if (loading) return <GroupedListSkeleton />;
  if (docsError) {
    return <div className="p-4 text-danger">Failed to load the grouped list.</div>;
  }

  const data = summary.data;
  const groups = data?.groups ?? [];
  const ungrouped = data?.ungrouped ?? null;

  // Full-set total: sum the endpoint group counts + the ungrouped count. NOT the
  // loaded-page length (which is capped at PAGE_LIMIT).
  const total = groups.reduce((sum, g) => sum + g.count, 0) + (ungrouped?.count ?? 0);

  if (total === 0 && (page?.data?.length ?? 0) === 0) {
    return (
      <EmptyState
        title="No work items"
        description="This table has no work items yet. Create one to see it grouped here."
      />
    );
  }

  const pageCount = page?.data?.length ?? 0;
  const shownTo = Math.min(pageCount, total);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-[22px] py-2">
        {groups.map((g) => {
          const groupKey = g.value ?? NO_GROUP_KEY;
          const rows = rowsByGroup.get(g.value) ?? [];
          return (
            <section key={groupKey} className="flex flex-col gap-2">
              <GroupAggregateHeader
                label={g.value ?? '(no value)'}
                groupKey={groupKey}
                row={g}
                aggregates={settings.aggregates}
              />
              {rows.map((doc) => (
                <GroupedListRow
                  key={doc.id}
                  doc={doc}
                  rowLayout={settings.rowLayout}
                  fields={fields ?? []}
                  onOpen={openDoc}
                />
              ))}
            </section>
          );
        })}

        {/* The "no group" bucket renders LAST (only when the endpoint reports it). */}
        {ungrouped ? (
          <section className="flex flex-col gap-2">
            <GroupAggregateHeader
              label="No group"
              groupKey={NO_GROUP_KEY}
              row={ungrouped}
              aggregates={settings.aggregates}
            />
            {(rowsByGroup.get(null) ?? []).map((doc) => (
              <GroupedListRow
                key={doc.id}
                doc={doc}
                rowLayout={settings.rowLayout}
                fields={fields ?? []}
                onOpen={openDoc}
              />
            ))}
          </section>
        ) : null}

        {summary.data?.truncated ? (
          <div className="px-1 text-xs text-fg-3">
            Showing the first groups — more groups exist (refine the grouping to see all).
          </div>
        ) : null}
      </div>

      <div
        data-testid="grouped-list-pager"
        className="flex items-center justify-between border-t border-border-light px-[22px] py-2 text-xs text-fg-3"
      >
        <span>
          Toont {total === 0 ? 0 : 1}–{shownTo} van {total}
        </span>
      </div>
    </div>
  );

  function openDoc(slug: string) {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  }
}
