import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  type DocumentSummary,
  clausesToListParams,
  parseFilters,
  useDocuments,
  useUpdateDocument,
} from '../../lib/api/documents.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { type DueUrgency, dueUrgency } from '../../lib/due-urgency.ts';
import { cn } from '../ui/cn.ts';
import { bucketKey, buildMonthGrid, placeDocuments } from './calendar-grid.ts';
import { CalendarSkeleton } from './calendar-skeleton.tsx';
import { EmptyState } from './empty-state.tsx';
import { settingString } from './view-settings.ts';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
  /**
   * Test/router seam for the initially-shown month (1-based). Defaults to the
   * current month — the grid itself is built TZ-safe by buildMonthGrid; this
   * default only picks WHICH month opens first.
   */
  initialMonth?: { year: number; month: number };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Accent classes for a doc chip keyed by its due-date urgency. */
function chipAccent(u: DueUrgency): string {
  switch (u) {
    case 'overdue':
      return 'border-danger/40 text-danger';
    case 'soon':
      return 'border-warning/40 text-warning';
    default:
      return 'border-border-light text-fg-2';
  }
}

function currentMonth(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** A draggable doc chip. id = doc.slug so onDragEnd's active.id resolves the doc. */
function DocChip({
  doc,
  className,
  onOpen,
}: {
  doc: DocumentSummary;
  className: string;
  onOpen: (slug: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: doc.slug });
  return (
    <button
      ref={setNodeRef}
      type="button"
      // Open on click; drag is gated behind PointerSensor's 5px activation
      // distance so a plain click never starts a drag.
      onClick={() => onOpen(doc.slug)}
      title={doc.title}
      className={cn(className, isDragging && 'opacity-40')}
      {...listeners}
      {...attributes}
    >
      {doc.title}
    </button>
  );
}

/** A droppable day cell. id = the cell's ISO date so over.id IS the target day. */
function DayCellDropzone({
  iso,
  inMonth,
  children,
}: {
  iso: string;
  inMonth: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: iso });
  return (
    <div
      ref={setNodeRef}
      data-testid="calendar-day-cell"
      className={cn(
        'min-h-[72px] bg-shell p-1',
        !inMonth && 'bg-card/50 text-fg-3',
        isOver && 'ring-1 ring-inset ring-primary',
      )}
    >
      <div data-testid={`calendar-cell-${iso}`} className="flex h-full flex-col gap-1">
        {children}
      </div>
    </div>
  );
}

export function CalendarView({ wslug, pslug, tslug, initialMonth }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { view } = useActiveView(wslug, pslug, tslug);

  // Per-view placement field (default 'due_date' when unset). settingString
  // narrows + rejects the empty string (an inline `typeof === 'string'` check
  // would let `''` through and orphan every doc into the unscheduled tray).
  const dateField = settingString(view?.settings?.dateField, 'due_date');

  // The shared FilterBar PATCHes the URL search; parse it into the documents
  // query so the calendar narrows by the active filter (status/priority/labels/
  // assignee/updated_since), mirroring TableView. limit:200 + type are pinned
  // for the calendar's month-at-a-glance read; the filter clauses merge in.
  const clauses = useMemo(() => parseFilters(search), [search]);
  const listParams = useMemo(
    () => ({ ...clausesToListParams(clauses), type: 'work_item' as const, limit: 200 }),
    [clauses],
  );

  const [cursor, setCursor] = useState<{ year: number; month: number }>(
    () => initialMonth ?? currentMonth(),
  );

  const { data: page, isLoading, error } = useDocuments(wslug, pslug, tslug, listParams);

  const docs = useMemo(() => page?.data ?? [], [page]);
  const grid = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);
  const { byDay, unscheduled } = useMemo(() => placeDocuments(docs, dateField), [docs, dateField]);

  const docsBySlug = useMemo(() => {
    const m = new Map<string, DocumentSummary>();
    for (const d of docs) m.set(d.slug, d);
    return m;
  }, [docs]);

  // SAME listParams key as the read so the date-drag's optimistic update
  // invalidates the FILTERED query — otherwise a drag would write into the
  // unfiltered cache and the filtered view would not reflect it.
  const update = useUpdateDocument(wslug, pslug, tslug, listParams);

  // 5px activation distance so a plain click on a chip opens the slideover and
  // never starts a drag. Mirrors the kanban board's sensor config.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // The slug currently dragged — drives the DragOverlay clone (portals above the
  // grid so the chip isn't clipped by the cell's overflow). Set on start, cleared
  // on end/cancel.
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onDragStart = (event: DragStartEvent) => {
    setActiveSlug(String(event.active.id));
  };

  const onDragCancel = () => setActiveSlug(null);

  // INVARIANT 16: the dragged date is a DOCUMENT attribute, so the drop writes
  // frontmatter[dateField] on the DOCUMENT — never the view. over.id is the
  // target cell's ISO date (DayCellDropzone id = cell.iso); a cell carries its
  // REAL iso even for trailing next-month cells, so a cross-month drop lands the
  // right date. The patch sends ONLY the changed dateField key — the server
  // merge-patches frontmatter (useUpdateDocument.mergeFrontmatter mirrors it).
  const onDragEnd = async (event: DragEndEvent) => {
    setActiveSlug(null);
    const { active, over } = event;
    if (!over) return;
    const slug = String(active.id);
    const targetIso = String(over.id);
    const doc = docsBySlug.get(slug);
    // No-op when the chip is dropped on the day it already sits on (its bucketed
    // date equals the target). bucketKey reads the doc's OWN date field in O(1) —
    // the same derivation placeDocuments used to bucket it; an unscheduled chip
    // has no bucket (null), so any cell drop is a real change.
    const currentKey = doc ? bucketKey(doc.frontmatter[dateField]) : null;
    if (currentKey === targetIso) return;
    try {
      await update.mutateAsync({ slug, patch: { frontmatter: { [dateField]: targetIso } } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const goPrev = () =>
    setCursor((c) =>
      c.month === 1 ? { year: c.year - 1, month: 12 } : { ...c, month: c.month - 1 },
    );
  const goNext = () =>
    setCursor((c) =>
      c.month === 12 ? { year: c.year + 1, month: 1 } : { ...c, month: c.month + 1 },
    );
  const goToday = () => setCursor(currentMonth());

  if (isLoading) return <CalendarSkeleton />;
  if (error) return <div className="p-4 text-danger">Failed to load calendar.</div>;

  const monthLabel = `${MONTH_NAMES[cursor.month - 1]} ${cursor.year}`;
  const isEmpty = docs.length === 0;

  // Shared chip styling so a day-cell chip and its DragOverlay clone match.
  const dayChipClass = (doc: DocumentSummary) =>
    cn(
      'truncate rounded-sm border bg-shell px-1.5 py-0.5 text-left text-xs hover:bg-card',
      chipAccent(dueUrgency(doc.frontmatter[dateField])),
    );
  const trayChipClass =
    'truncate rounded-sm border border-border-light bg-shell px-1.5 py-0.5 text-left text-xs text-fg-2 hover:bg-card';
  const activeDoc = activeSlug ? (docsBySlug.get(activeSlug) ?? null) : null;
  // Scheduled iff the doc has a valid bucket key — the same O(1) predicate
  // placeDocuments uses to decide byDay vs unscheduled (no byDay scan).
  const activeIsScheduled = activeDoc
    ? bucketKey(activeDoc.frontmatter[dateField]) !== null
    : false;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {/* No px-[22px] py-2 here — MainFrame's children container already
          supplies it; re-applying double-padded the view (mis-aligned with the
          header). Match kanban/wiki-tree, which deliberately don't re-apply it. */}
      <div className="flex h-full min-h-0 flex-col">
        {/* Month-nav header */}
        <div className="mb-3 flex items-center gap-2">
          <h2 data-testid="calendar-month-label" className="text-base font-medium text-fg">
            {monthLabel}
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={goPrev}
              className="rounded-sm px-2 py-1 text-xs text-fg-2 hover:bg-card"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={goToday}
              className="rounded-sm px-2 py-1 text-xs text-fg-2 hover:bg-card"
            >
              Today
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={goNext}
              className="rounded-sm px-2 py-1 text-xs text-fg-2 hover:bg-card"
            >
              ›
            </button>
          </div>
        </div>

        {/* Weekday header row */}
        <div className="grid grid-cols-7 gap-px text-xs font-medium text-fg-3">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-1">
              {d}
            </div>
          ))}
        </div>

        {isEmpty ? (
          <div data-testid="calendar-empty" className="border-b border-border-light">
            <EmptyState
              title="No work items"
              description="This table has no work items yet. Create one to see it on the calendar."
            />
          </div>
        ) : null}
        <div className="grid flex-1 grid-cols-7 gap-px overflow-auto rounded-md bg-border-light">
          {grid.map((cell) => {
            const dayDocs = byDay[cell.iso] ?? [];
            return (
              <DayCellDropzone key={cell.iso} iso={cell.iso} inMonth={cell.inMonth}>
                <div className={cn('text-xs', cell.inMonth ? 'text-fg-2' : 'text-fg-3')}>
                  {cell.day}
                </div>
                {dayDocs.map((doc) => (
                  <DocChip
                    key={doc.slug}
                    doc={doc}
                    className={dayChipClass(doc)}
                    onOpen={openDoc}
                  />
                ))}
              </DayCellDropzone>
            );
          })}
        </div>

        {/* Unscheduled tray — only when non-empty */}
        {unscheduled.length > 0 ? (
          <div data-testid="calendar-unscheduled" className="mt-3 shrink-0">
            <div className="mb-1 text-xs font-medium text-fg-3">
              Unscheduled ({unscheduled.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {unscheduled.map((doc) => (
                <DocChip key={doc.slug} doc={doc} className={trayChipClass} onOpen={openDoc} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {/* The dragged chip's clone. DragOverlay portals to the body so it escapes
          the cell's overflow clip and paints on top of the grid. */}
      <DragOverlay>
        {activeDoc ? (
          <div className={activeIsScheduled ? dayChipClass(activeDoc) : trayChipClass}>
            {activeDoc.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
