import type { AggregateSpec, GroupedListSettings } from '@folio/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  type DocumentPatch,
  type DocumentSummary,
  applyFrontmatterClauses,
  clausesToListParams,
  parseFilters,
  useCreateDocument,
  useDocuments,
  useInfiniteDocuments,
  useUpdateDocument,
} from '../../lib/api/documents.ts';
import { useCreateField, useDeleteField, useFields, useUpdateField } from '../../lib/api/fields.ts';
import type { FieldType } from '../../lib/api/fields.ts';
import { useGroupSummary } from '../../lib/api/group-summary.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useTables } from '../../lib/api/tables.ts';
import { useUpdateView, useViews } from '../../lib/api/views.ts';
import { Icon } from '../ui/icon.tsx';
import { EmptyState } from '../views/empty-state.tsx';
import { GroupHeaderRow } from '../views/group-header-row.tsx';
import { defaultGroupedListSettings } from '../views/grouped-list-config.tsx';
import { ListSkeleton } from '../views/list-skeleton.tsx';
import { ColumnMenu } from './column-menu.tsx';
import { ColumnPicker } from './column-picker.tsx';
import { columnSuggestions } from './column-suggestions.ts';
import { ColumnTypeChange } from './column-type-change.tsx';
import { type Column, applyColumnOrder, effectiveVisibleKeys, mergeColumns } from './columns.ts';
import { setColumnSnapshot } from './current-columns-store.ts';
import { type AddColumnPayload, TableAddColumn } from './table-add-column.tsx';
import { TableAddRow } from './table-add-row.tsx';
import { type SortState, TableHeader } from './table-header.tsx';
import { TableRow } from './table-row.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

/** Collapse-state key + GroupHeaderRow testid suffix for the ungrouped bucket. */
const NO_GROUP_KEY = '__nogroup__';

/** Read the active view's `settings` as GroupedListSettings, with safe defaults. */
function resolveGroupSettings(settings: Record<string, unknown> | undefined): GroupedListSettings {
  const defaults = defaultGroupedListSettings();
  if (!settings || typeof settings !== 'object') return defaults;
  const s = settings as Partial<GroupedListSettings>;
  return {
    groupBy: typeof s.groupBy === 'string' && s.groupBy ? s.groupBy : defaults.groupBy,
    aggregates:
      Array.isArray(s.aggregates) && s.aggregates.length > 0 ? s.aggregates : defaults.aggregates,
    rowLayout:
      s.rowLayout && typeof s.rowLayout === 'object' && typeof s.rowLayout.primary === 'string'
        ? {
            primary: s.rowLayout.primary,
            subtitle: s.rowLayout.subtitle,
            fields: s.rowLayout.fields ?? [],
          }
        : defaults.rowLayout,
  };
}

/**
 * The group value a loaded row falls under — DISPLAY placement only. `status`
 * reads the column; any other key reads frontmatter. Empty/missing → `null`
 * (the ungrouped bucket).
 *
 * Exported for direct unit tests.
 */
export function bucketValue(doc: DocumentSummary, groupBy: string): string | null {
  const raw =
    groupBy === 'status' ? doc.status : (doc.frontmatter as Record<string, unknown>)[groupBy];
  if (raw === null || raw === undefined || raw === '') return null;
  // S1: a BOOLEAN groupBy field is read server-side via json_extract, which
  // yields 1/0 — so the summary group VALUE is "1"/"0". The client holds the JS
  // boolean here; `String(true)` = "true" would MISMATCH "1" and orphan the row
  // (it would land in no section). Normalize to the server's representation.
  if (typeof raw === 'boolean') return raw ? '1' : '0';
  return String(raw);
}

export function TableView({ wslug, pslug, tslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const clauses = useMemo(() => parseFilters(search), [search]);

  const sort: SortState | null = useMemo(() => {
    const k = typeof search.sort === 'string' ? search.sort : null;
    const d = typeof search.dir === 'string' ? search.dir : null;
    if (!k) return null;
    return { key: k as SortState['key'], dir: (d as SortState['dir']) ?? 'asc' };
  }, [search.sort, search.dir]);

  const listParams = useMemo(() => {
    const base = clausesToListParams(clauses);
    return sort ? { ...base, sort: sort.key, dir: sort.dir } : base;
  }, [clauses, sort]);

  const {
    data: infinite,
    isLoading,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteDocuments(wslug, pslug, tslug, listParams);
  // Same-tick double-click guard: `isFetchingNextPage` only flips on the NEXT
  // render, so two synchronous clicks would both call fetchNextPage before the
  // button disables. This ref is set synchronously on the first click and
  // cleared when the fetch settles, so the second click is a no-op — no
  // duplicate page fetch, no skipped cursor.
  const loadingMoreRef = useRef(false);
  const onLoadMore = useCallback(() => {
    if (loadingMoreRef.current || isFetchingNextPage || !hasNextPage) return;
    loadingMoreRef.current = true;
    void fetchNextPage().finally(() => {
      loadingMoreRef.current = false;
    });
  }, [fetchNextPage, isFetchingNextPage, hasNextPage]);
  // Flatten all loaded pages into one row list. `pageData` replaces the old
  // single-page `page.data` everywhere below, so column synthesis / suggestions
  // / affected-doc counts see every loaded row, not just the first page.
  const pageData = useMemo(() => (infinite?.pages ?? []).flatMap((pg) => pg.data), [infinite]);
  const { data: statuses } = useStatuses(wslug, pslug, tslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  // Resolve relation [[slug]] tokens to titles in read-only table cells. The
  // table's main `page` query is filtered (status/assignee), so we run two
  // extra unfiltered queries to build the slug→title map. Finding 9.
  // O5 (health audit): only fetch them when this table actually HAS a relation
  // column — otherwise every table mount paid for two unbounded list queries
  // it never used.
  //
  // SCOPE CAVEAT (CR Cluster-1 #4): `useDocuments` is table-scoped — it always
  // hits /t/<tslug>/documents. The server constrains `type=work_item` to that
  // table (services/documents.ts:254-257), so `relItems` only covers THIS
  // table's work_items, NOT the whole project. `relPages` IS project-wide
  // (pages are tableId=null, so the server returns every project page
  // regardless of tslug — documents.ts:258-260). Consequence: a relation chip
  // pointing at a work_item in ANOTHER table of the same project does not
  // resolve here and renders as a struck-through chip. This is a PRE-EXISTING
  // limitation, not a Cluster-1 regression: before this branch the resolver
  // hit /p/<pslug>/documents, which `resolveProject` auto-scopes to the
  // project's DEFAULT table (scope.ts:120-123) — so it only ever resolved the
  // default table's work_items either way. No endpoint returns work_items
  // across all tables (verified: REST, MCP agent-tools, folio-api all set
  // activeTableId). Fixing cross-table relation chips needs a project-wide
  // document index — tracked as a follow-up.
  const hasRelationColumn = (fields ?? []).some((f) => f.type === 'relation');
  const { data: relPages } = useDocuments(
    wslug,
    pslug,
    tslug,
    { type: 'page' },
    { enabled: hasRelationColumn },
  );
  const { data: relItems } = useDocuments(
    wslug,
    pslug,
    tslug,
    { type: 'work_item' },
    { enabled: hasRelationColumn },
  );
  const { data: viewsData } = useViews(wslug, pslug, tslug);
  const { data: tablesData } = useTables(wslug, pslug);
  const update = useUpdateDocument(wslug, pslug, tslug, listParams);
  const create = useCreateDocument(wslug, pslug, tslug);
  const updateView = useUpdateView(wslug, pslug, tslug);
  const createField = useCreateField(wslug, pslug, tslug);
  const updateField = useUpdateField(wslug, pslug, tslug);
  const deleteField = useDeleteField(wslug, pslug, tslug);
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [changingTypeKey, setChangingTypeKey] = useState<string | null>(null);

  const urlViewId = typeof search.view === 'string' ? search.view : undefined;

  const activeView = useMemo(() => {
    const list = viewsData ?? [];
    if (urlViewId) {
      const found = list.find((v) => v.id === urlViewId);
      if (found) return found;
    }
    return list.find((v) => v.isDefault) ?? list[0] ?? null;
  }, [urlViewId, viewsData]);

  // Filter/sort hydration from the active view is OWNED by ViewControls (mounted
  // once in the project header for every view type) — TableView only READS the
  // hydrated URL `search` (→ clauses → listParams above). It does NOT hydrate
  // itself, so there is a SINGLE hydration owner and no double-navigate race.

  const allColumns: Column[] = useMemo(
    // Pass the loaded docs so mergeColumns can synthesize columns for visible
    // frontmatter keys that aren't pinned Fields — else effectiveVisibleKeys
    // drops them and a column-toggle silently destroys them (views-UX round 2).
    () => mergeColumns(fields ?? [], activeView, pageData),
    [fields, activeView, pageData],
  );
  const orderedColumns: Column[] = useMemo(
    () => applyColumnOrder(allColumns, activeView?.columnOrder ?? null),
    [allColumns, activeView],
  );
  const visibleKeys = useMemo(
    () => effectiveVisibleKeys(allColumns, activeView),
    [allColumns, activeView],
  );
  const visibleColumns = useMemo(
    () => orderedColumns.filter((c) => visibleKeys.includes(c.key)),
    [orderedColumns, visibleKeys],
  );

  // Publish the columns the user is CURRENTLY looking at to the cross-tree
  // snapshot store, so the New-view sheet (in the rail, a render sibling) can
  // seed a created view as a copy of this on-screen set + order. visibleColumns
  // already encodes exactly what's rendered, so no re-resolution here; keyed by
  // tslug so a view created from another table's rail row reads that table's set.
  useEffect(() => {
    const keys = visibleColumns.map((c) => c.key);
    setColumnSnapshot(tslug, { visibleFields: keys, columnOrder: keys });
  }, [tslug, visibleColumns]);

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onCreate = async (title = 'Untitled') => {
    try {
      const created = await create.mutateAsync({ type: 'work_item', title });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onSortChange = (next: SortState | null) => {
    // 1) Update URL (existing behavior, unchanged)
    const nextSearch: Record<string, unknown> = { ...search };
    if (next) {
      nextSearch.sort = next.key;
      nextSearch.dir = next.dir;
    } else {
      // biome-ignore lint/performance/noDelete: must REMOVE the keys from the router search object so the param drops from the URL — `= undefined` keeps a stale ?sort= key
      delete nextSearch.sort;
      // biome-ignore lint/performance/noDelete: see above — drop the URL param, don't set it undefined
      delete nextSearch.dir;
    }
    void navigate({ to: '.', search: nextSearch, replace: false });

    // 2) Auto-save to active view (parity with columnOrder + visibleFields).
    // Same consent gate as onClauseChange — only mutate when the user
    // explicitly opened this view via ?view=<id>.
    if (!urlViewId || !activeView || activeView.id !== urlViewId) return;
    const patchSort = next ? [{ key: next.key, dir: next.dir }] : [];
    updateView.mutate(
      { id: activeView.id, patch: { sort: patchSort } },
      {
        onError: (err) => toast.error(formatApiError(err)),
      },
    );
  };

  const onUpdate = useCallback(
    async (slug: string, patch: DocumentPatch) => {
      setPendingSlugs((prev) => new Set(prev).add(slug));
      try {
        await update.mutateAsync({ slug, patch });
      } finally {
        setPendingSlugs((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
      }
    },
    [update],
  );

  const onVisibilityChange = async (next: string[]) => {
    if (!activeView) return;
    try {
      await updateView.mutateAsync({ id: activeView.id, patch: { visibleFields: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onReorder = async (next: string[]) => {
    if (!activeView) return;
    try {
      await updateView.mutateAsync({ id: activeView.id, patch: { columnOrder: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onAddColumn = useCallback(
    async (payload: AddColumnPayload) => {
      const created = await createField.mutateAsync(payload);
      if (activeView) {
        const nextVisible = [
          ...(activeView.visibleFields ?? effectiveVisibleKeys(allColumns, activeView)),
          created.key,
        ];
        try {
          await updateView.mutateAsync({
            id: activeView.id,
            patch: { visibleFields: nextVisible },
          });
        } catch (err) {
          toast.error(formatApiError(err));
        }
      }
    },
    [createField, activeView, allColumns, updateView],
  );

  // Pin handler for the ColumnPicker's "Suggested from your data" rows. We
  // reuse `onAddColumn` so the POST + visible-fields update path is identical
  // to the manual `+ Add column` flow. Suggestions never carry options
  // (select/currency can't be inferred from a single sample), so the
  // AddColumnPayload's `options` field is naturally omitted.
  const onPinSuggestion = useCallback(
    async (payload: { key: string; type: FieldType; label: string }) => {
      await onAddColumn(payload);
    },
    [onAddColumn],
  );

  const filteredDocs = useMemo(
    () => applyFrontmatterClauses(pageData, clauses),
    [pageData, clauses],
  );

  // A.2: grouping is ON when the active view is a `list` type — the same
  // spreadsheet table, rendered as group sections. A `table` view is flat.
  const grouping = activeView?.type === 'list';
  const groupSettings: GroupedListSettings = useMemo(
    () => resolveGroupSettings(activeView?.settings),
    [activeView],
  );
  const groupBy = grouping ? groupSettings.groupBy : null;
  const aggregates: AggregateSpec[] = grouping ? groupSettings.aggregates : [];

  // Headers (full-set counts + aggregates) come from the group-summary endpoint,
  // fed the SAME server filter as the rows so headers and rows stay consistent.
  // `useGroupSummary` self-gates `enabled` on groupBy + a non-empty aggregates
  // list, so a `table` view never issues the request.
  const groupSummary = useGroupSummary(
    wslug,
    pslug,
    tslug,
    { groupBy: groupBy ?? '', aggregates, filter: listParams.filter, type: 'work_item' },
    { enabled: grouping },
  );

  // Collapse state — a local Set of group keys (the endpoint value, or
  // `NO_GROUP_KEY` for the ungrouped bucket).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Grouping only actually renders sections when the endpoint returned groups (or
  // an ungrouped bucket). While the summary is loading/empty/errored we fall back
  // to the flat list so the table is never blank.
  const summaryGroups = groupSummary.data?.groups ?? [];
  const summaryUngrouped = groupSummary.data?.ungrouped ?? null;
  const renderGrouped = grouping && (summaryGroups.length > 0 || summaryUngrouped !== null);

  // FIX I1: when the group-summary read FAILS on a list view, surface an error
  // affordance — do NOT silently degrade to a flat, ungrouped view with no
  // signal. The rows still load (the flat fallback below renders them).
  const groupSummaryError = grouping && groupSummary.isError;

  // Bucket the LOADED rows by their groupBy value — DISPLAY placement only; the
  // header count never comes from these (the page-2 guard).
  //
  // FIX I2 (orphan fold): when the endpoint truncates the group set (>MAX_GROUPS
  // distinct values → truncated:true), a loaded row whose group was capped away
  // has NO matching header, so its own map entry would never be iterated and the
  // row would silently vanish. Fold any such orphan into the ungrouped (`null`)
  // bucket so it always renders SOMEWHERE rather than disappearing.
  const rowsByGroup = useMemo(() => {
    const map = new Map<string | null, DocumentSummary[]>();
    if (!groupBy) return map;
    const known = new Set(summaryGroups.map((g) => g.value));
    for (const doc of filteredDocs) {
      const raw = bucketValue(doc, groupBy);
      // A non-null value with no matching summary header is an orphan (its group
      // was truncated away) → fold into the ungrouped bucket so it never drops.
      const key = raw !== null && !known.has(raw) ? null : raw;
      const existing = map.get(key);
      if (existing) existing.push(doc);
      else map.set(key, [doc]);
    }
    return map;
  }, [filteredDocs, groupBy, summaryGroups]);

  const docs = pageData;

  // slug→{slug,title} resolver covering the project's pages + THIS table's
  // work_items (see the SCOPE CAVEAT on relItems above — cross-table work_item
  // relations don't resolve), so relation cells render valid links as titled
  // chips (not struck-through).
  const relationResolve = useMemo(() => {
    const map = new Map<string, { slug: string; title: string }>();
    for (const d of relPages?.data ?? []) map.set(d.slug, { slug: d.slug, title: d.title });
    for (const d of relItems?.data ?? []) map.set(d.slug, { slug: d.slug, title: d.title });
    return (slug: string) => map.get(slug) ?? null;
  }, [relPages, relItems]);

  const suggestions = useMemo(() => {
    // Exclude any key already represented as a column — that now includes
    // SYNTHESIZED columns (visible frontmatter keys that aren't pinned Fields).
    // Without this, a synthesized column like `priority` would also appear as a
    // "Suggested from your data" row, i.e. a duplicate the user could "pin"
    // onto a key that's already a column (views-UX round 2).
    const columnKeys = new Set(allColumns.map((c) => c.key));
    return columnSuggestions(docs, fields ?? []).filter((s) => !columnKeys.has(s.key));
  }, [docs, fields, allColumns]);

  // Build the per-column menu. Builtins (title/status/updated_at) intentionally
  // skip the menu — they're not deletable. For pinned fields we surface the
  // affected-doc count so the delete confirmation can warn the user.
  const renderColumnMenu = useCallback(
    (column: Column) => {
      if (column.source !== 'field') return null;
      const field = (fields ?? []).find((f) => f.key === column.key);
      if (!field) return null;
      const affected = docs.filter(
        (d) => d.frontmatter && (d.frontmatter as Record<string, unknown>)[column.key] != null,
      ).length;
      return (
        <ColumnMenu
          columnKey={column.key}
          columnLabel={column.label}
          affectedDocCount={affected}
          onRename={() => setRenamingKey(column.key)}
          onChangeType={() => setChangingTypeKey(column.key)}
          onHide={() => {
            if (!activeView) return;
            const nextVisible = visibleKeys.filter((k) => k !== column.key);
            updateView.mutate(
              { id: activeView.id, patch: { visibleFields: nextVisible } },
              { onError: (err) => toast.error(formatApiError(err)) },
            );
          }}
          onDelete={async () => {
            try {
              await deleteField.mutateAsync(field.id);
            } catch (err) {
              toast.error(formatApiError(err));
              throw err;
            }
          }}
        />
      );
    },
    [fields, docs, deleteField, activeView, visibleKeys, updateView],
  );

  // Commit handler for the inline-rename. Looks up the field by key inside the
  // callback (rather than capturing `field` per-render) so we always see the
  // freshest `fields` list. Empty / unchanged inputs are no-ops and just clear
  // the renaming state.
  const onRenameCommit = useCallback(
    (key: string, next: string) => {
      setRenamingKey(null);
      const trimmed = next.trim();
      const field = (fields ?? []).find((f) => f.key === key);
      if (!field) return;
      if (!trimmed || trimmed === field.label) return;
      updateField.mutate(
        { id: field.id, patch: { label: trimmed } },
        { onError: (err) => toast.error(formatApiError(err)) },
      );
    },
    [fields, updateField],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* B.6: the FilterBar + the grouped-list settings (group-by + aggregates)
          moved to the unified ViewControls in the project header (mounted once
          for every view). TableView still READS the hydrated URL filter for its
          listParams — it just no longer OWNS the filter/settings UI. */}
      <div
        data-testid="table-scroll"
        className="folio-scroll -mx-[22px] flex-1 min-h-0 overflow-auto"
      >
        {/* No left padding here: the sticky first column owns its own 22px
            of left whitespace via `pl-[22px]` so the whitespace stays put
            from the first pixel of horizontal scroll (instead of collapsing
            as the row slides left until the cell hits left:0).

            `w-max` sizes this wrapper to its content (the grid's intrinsic
            width). Without it, each row's `w-full` resolved to the parent's
            layout width — which equals the viewport on overflow — so the
            row's bottom border stopped where the viewport ended, leaving
            the rightmost columns visually unbordered when you horizontally
            scrolled. Bug E (2026-05-26). */}
        {/* `min-w-full` raises the floor to the scroll container's width when
            content is NARROWER than the viewport, so the table fills the dead
            right space — without touching gridTemplate, so the fixed-px tracks +
            flush borders are unchanged (Bug E intact). min-width only raises; the
            wider `w-max` wins on horizontal overflow, so the two never conflict. */}
        <div className="w-max min-w-full pr-[22px]">
          <TableHeader
            columns={visibleColumns}
            sort={sort}
            onSort={onSortChange}
            onReorder={onReorder}
            trailing={
              <TableAddColumn
                onSubmit={onAddColumn}
                tables={(Array.isArray(tablesData) ? tablesData : []).map((t) => ({
                  id: t.id,
                  name: t.name,
                }))}
              />
            }
            settings={
              <ColumnPicker
                columns={allColumns}
                visibleKeys={visibleKeys}
                onChange={onVisibilityChange}
                suggestions={suggestions}
                onPinSuggestion={onPinSuggestion}
              />
            }
            renderColumnMenu={renderColumnMenu}
            renamingKey={renamingKey}
            onRenameCommit={onRenameCommit}
          />
          {isLoading ? <ListSkeleton rows={6} /> : null}
          {error ? <div className="p-4 text-danger">Failed to load documents.</div> : null}
          {!isLoading && !error && filteredDocs.length === 0 ? (
            <EmptyState
              icon={clauses.length === 0 ? <Icon icon={Inbox} size={20} /> : undefined}
              title={clauses.length > 0 ? 'No matching documents' : 'No work items yet'}
              description={
                clauses.length > 0
                  ? 'Try removing a filter chip above.'
                  : 'Create your first work item to get started.'
              }
              action={
                clauses.length === 0
                  ? { label: 'Create your first work item', onClick: () => void onCreate() }
                  : undefined
              }
            />
          ) : null}
          {/* FIX I1: group-summary failure affordance. The rows still render
              (flat fallback below) so the table is never blank — this banner is
              the SIGNAL that grouping/aggregates failed. */}
          {groupSummaryError ? (
            <div data-testid="group-summary-error" className="px-4 py-2 text-sm text-danger">
              Kon de groepssamenvatting niet laden.
            </div>
          ) : null}
          <div role="list" className="flex flex-col">
            {renderGrouped
              ? (() => {
                  const renderRow = (doc: DocumentSummary) => (
                    <TableRow
                      key={doc.id}
                      doc={doc}
                      columns={visibleColumns}
                      statuses={statuses ?? []}
                      wslug={wslug}
                      pslug={pslug}
                      isPending={pendingSlugs.has(doc.slug)}
                      onOpen={openDoc}
                      onUpdate={onUpdate}
                      resolveRelation={relationResolve}
                    />
                  );
                  return (
                    <>
                      {summaryGroups.map((g) => {
                        const key = g.value ?? NO_GROUP_KEY;
                        const collapsed = collapsedGroups.has(key);
                        const rows = rowsByGroup.get(g.value) ?? [];
                        return (
                          <div key={key} className="flex flex-col">
                            <GroupHeaderRow
                              row={g}
                              aggregates={aggregates}
                              groupBy={groupBy ?? ''}
                              label={g.value ?? '(none)'}
                              collapsed={collapsed}
                              onToggle={() => toggleGroup(key)}
                            />
                            {!collapsed ? rows.map(renderRow) : null}
                          </div>
                        );
                      })}
                      {/* The ungrouped bucket renders LAST. */}
                      {summaryUngrouped ? (
                        <div key={NO_GROUP_KEY} className="flex flex-col">
                          <GroupHeaderRow
                            row={summaryUngrouped}
                            aggregates={aggregates}
                            groupBy={groupBy ?? ''}
                            label="(none)"
                            collapsed={collapsedGroups.has(NO_GROUP_KEY)}
                            onToggle={() => toggleGroup(NO_GROUP_KEY)}
                          />
                          {!collapsedGroups.has(NO_GROUP_KEY)
                            ? (rowsByGroup.get(null) ?? []).map(renderRow)
                            : null}
                        </div>
                      ) : null}
                      {/* FIX I2: the endpoint capped the distinct group set
                          (truncated:true) — signal that more groups exist so the
                          user knows the sections aren't the complete picture. */}
                      {groupSummary.data?.truncated ? (
                        <div data-testid="groups-truncated" className="px-4 py-2 text-xs text-fg-3">
                          Showing the first groups — more groups exist (refine the grouping to see
                          all).
                        </div>
                      ) : null}
                    </>
                  );
                })()
              : filteredDocs.map((doc) => (
                  <TableRow
                    key={doc.id}
                    doc={doc}
                    columns={visibleColumns}
                    statuses={statuses ?? []}
                    wslug={wslug}
                    pslug={pslug}
                    isPending={pendingSlugs.has(doc.slug)}
                    onOpen={openDoc}
                    onUpdate={onUpdate}
                    resolveRelation={relationResolve}
                  />
                ))}
            {!isLoading && !error && filteredDocs.length > 0 ? (
              <TableAddRow
                columns={visibleColumns}
                isPending={create.isPending}
                onCreate={(title) => void onCreate(title)}
              />
            ) : null}
          </div>
          {/* Load more: present only when the server reported another page
              (nextCursor non-null → hasNextPage). Last page → button absent, no
              further fetch. Disabled while a page is in flight so a double-click
              cannot fire two fetches (react-query also dedupes the same key). */}
          {!isLoading && !error && hasNextPage ? (
            <div className="flex justify-center py-3">
              <button
                type="button"
                data-testid="load-more"
                disabled={isFetchingNextPage}
                onClick={onLoadMore}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {changingTypeKey
        ? (() => {
            const field = (fields ?? []).find((f) => f.key === changingTypeKey);
            if (!field) return null;
            return (
              <ColumnTypeChange
                currentType={field.type}
                currentOptions={field.options}
                open={!!changingTypeKey}
                onClose={() => setChangingTypeKey(null)}
                onSubmit={async ({ type, options }) => {
                  // Translate the dialog's payload into a server PATCH:
                  //   options === undefined → omit options key
                  //   options === null      → send options: null (server drops to null)
                  //   options is string[]   → send options: [...iso]
                  const patch: { type: FieldType; options?: string[] | null } = { type };
                  if (options !== undefined) patch.options = options;
                  await updateField.mutateAsync({ id: field.id, patch });
                }}
              />
            );
          })()
        : null}
    </div>
  );
}
