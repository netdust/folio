import type { GroupedListSettings } from '@folio/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useRef } from 'react';
import { type DocumentSummary, useInfiniteDocuments } from '../../lib/api/documents.ts';
import { useFields } from '../../lib/api/fields.ts';
import { useGroupSummary } from '../../lib/api/group-summary.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { EmptyState } from './empty-state.tsx';
import { GroupAggregateHeader } from './group-aggregate-header.tsx';
import { defaultGroupedListSettings } from './grouped-list-config.tsx';
import { GroupedListRow } from './grouped-list-row.tsx';
import { GroupedListSkeleton } from './grouped-list-skeleton.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

const PAGE_LIMIT = 50;
const NO_GROUP_KEY = '__nogroup__';

// S-1: one source of truth for the grouped-list defaults — `defaultGroupedListSettings()`
// from grouped-list-config.tsx (was a byte-identical local const here).
const DEFAULT_SETTINGS: GroupedListSettings = defaultGroupedListSettings();

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
 * come from `useGroupSummary` (the full-set endpoint); ROWS come from
 * `useInfiniteDocuments` with a "Load more" button so EVERY row is reachable
 * (the page-2 fix — a single page hid rows 51+). Loaded rows are bucketed
 * client-side ONLY to decide which section they render under — never to compute
 * a header total (the page-2 guard).
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

  // FIX I-3: full pagination. The single-page `useDocuments` left rows 51+
  // unreachable (a >50-row table could never show a row past the first page —
  // e.g. 82 'done' rows filled the page and hid every todo/in_progress row).
  // `useInfiniteDocuments` + a "Load more" button makes every row reachable.
  const {
    data: infinite,
    isLoading: docsLoading,
    error: docsError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteDocuments(wslug, pslug, tslug, {
    type: 'work_item',
    limit: PAGE_LIMIT,
    filter,
  });

  // Flatten every loaded page into one row list — so rows past page 1 bucket and
  // render, not just the first page's rows.
  const loadedRows = useMemo(() => (infinite?.pages ?? []).flatMap((pg) => pg.data), [infinite]);

  // Same-tick double-click guard (mirrors table-view.tsx): `isFetchingNextPage`
  // only flips on the NEXT render, so two synchronous clicks would both call
  // fetchNextPage before the button disables. The ref is set synchronously on the
  // first click and cleared when the fetch settles, so the second click is a no-op.
  const loadingMoreRef = useRef(false);
  const onLoadMore = useCallback(() => {
    if (loadingMoreRef.current || isFetchingNextPage || !hasNextPage) return;
    loadingMoreRef.current = true;
    void fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  }, [fetchNextPage, isFetchingNextPage, hasNextPage]);

  // Bucket loaded rows by their group value — DISPLAY placement only.
  const rowsByGroup = useMemo(() => {
    const map = new Map<string | null, DocumentSummary[]>();
    for (const doc of loadedRows) {
      const key = rowGroupValue(doc, settings.groupBy);
      const existing = map.get(key);
      if (existing) existing.push(doc);
      else map.set(key, [doc]);
    }
    return map;
  }, [loadedRows, settings.groupBy]);

  const loading = viewLoading || summary.isLoading || docsLoading;
  if (loading) return <GroupedListSkeleton />;
  if (docsError) {
    return <div className="p-4 text-danger">Failed to load the grouped list.</div>;
  }

  const data = summary.data;
  const groups = data?.groups ?? [];
  const ungrouped = data?.ungrouped ?? null;

  // FIX I-1: the group-summary query can fail (a 422 from an incomplete spec, or
  // any error) while the documents query succeeds. Previously only `docsError`
  // was checked, so a failing summary rendered a silent empty view ("0 van 0",
  // no affordance). Surface it as a banner while STILL rendering whatever rows
  // loaded — don't blank the whole view.
  const summaryError = summary.isError || !!summary.error;

  // Full-set total: sum the endpoint group counts + the ungrouped count. NOT the
  // loaded-page length (which is capped at PAGE_LIMIT).
  const total = groups.reduce((sum, g) => sum + g.count, 0) + (ungrouped?.count ?? 0);

  // True empty state only when BOTH the summary is empty (no error) AND no rows
  // loaded. A summary error is NOT an empty state — it's a failure (I-1).
  if (total === 0 && loadedRows.length === 0 && !summaryError) {
    return (
      <EmptyState
        title="No work items"
        description="This table has no work items yet. Create one to see it grouped here."
      />
    );
  }

  const pageCount = loadedRows.length;
  // With full pagination, all rows are reachable: when there's no next page,
  // every loaded row is shown. The loaded count is the upper bound of what's on
  // screen (never exceeding the full-set total when known).
  const shownTo = total > 0 ? Math.min(pageCount, total) : pageCount;
  // When the summary failed, `groups` is empty so no section would render the
  // loaded rows — show them in a flat fallback bucket so they aren't lost.
  const orphanRows = summaryError && groups.length === 0 ? loadedRows : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-[22px] py-2">
        {summaryError ? (
          <div className="rounded-md border border-danger/30 px-3 py-2 text-sm text-danger">
            Kon de groepssamenvatting niet laden.
          </div>
        ) : null}

        {/* When the summary failed there are no group sections — render any loaded
            rows in a flat fallback so they aren't lost behind the error banner. */}
        {orphanRows.length > 0 ? (
          <section className="flex flex-col gap-2">
            {orphanRows.map((doc) => (
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

        {/* FIX I-3: "Load more" — present only when the server reported another
            page (hasNextPage). Disabled while a page is in flight; the
            same-tick ref guard prevents a double-click from firing two fetches. */}
        {hasNextPage ? (
          <div className="flex justify-center py-1">
            <button
              type="button"
              data-testid="grouped-list-load-more"
              disabled={isFetchingNextPage}
              onClick={onLoadMore}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-fg-3 hover:bg-shell disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Laden…' : 'Load more'}
            </button>
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
