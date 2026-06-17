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
import { type DocumentSummary, useDocuments, useUpdateDocument } from '../../lib/api/documents.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { useUpdateView } from '../../lib/api/views.ts';
import { type DueUrgency, dueUrgency } from '../../lib/due-urgency.ts';
import { cn } from '../ui/cn.ts';
import { bucketKey } from './calendar-grid.ts';
import { EmptyState } from './empty-state.tsx';
import {
  type TimeColumn,
  type TimelineZoom,
  buildTimeScale,
  placeOnTimeline,
} from './timeline-lanes.ts';
import { TimelineSkeleton } from './timeline-skeleton.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
  /**
   * Test/router seam for the scale window. When set, the scale spans exactly
   * [start, end] instead of being derived from the docs' min/max date — so
   * column-bucketed assertions don't depend on today's date. Production leaves
   * it unset and the range is computed from the data.
   */
  initialRange?: { start: string; end: string };
}

const ZOOMS: TimelineZoom[] = ['day', 'week', 'month'];
const ZOOM_LABELS: Record<TimelineZoom, string> = { day: 'Day', week: 'Week', month: 'Month' };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Narrow an unknown settings value to a non-empty string, else fall back. */
function settingString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** Narrow settings.zoom to a valid TimelineZoom, defaulting to 'week'. */
function settingZoom(value: unknown): TimelineZoom {
  return value === 'day' || value === 'week' || value === 'month' ? value : 'week';
}

/** Accent classes for a bar keyed by its due-date urgency. */
function barAccent(u: DueUrgency): string {
  switch (u) {
    case 'overdue':
      return 'bg-danger/15 border-danger/40 text-danger';
    case 'soon':
      return 'bg-warning/15 border-warning/40 text-warning';
    default:
      return 'bg-card border-border-light text-fg-2';
  }
}

/** ISO 'YYYY-MM-DD' for a UTC-midnight epoch-ms value. */
function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC-midnight epoch-ms for a 'YYYY-MM-DD' string. */
function msOfIso(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

/** Whole-day delta (b - a) between two 'YYYY-MM-DD' strings, UTC-safe. */
function dayDelta(a: string, b: string): number {
  return Math.round((msOfIso(b) - msOfIso(a)) / DAY_MS);
}

/** 'YYYY-MM-DD' for `iso` shifted by `days` (may be negative), UTC-safe. */
function shiftIso(iso: string, days: number): string {
  return isoOf(msOfIso(iso) + days * DAY_MS);
}

/**
 * Compute the scale window [start, end] from the docs' valid dates across the
 * configured fields, padded by one day each side. Returns null when no doc
 * carries any valid date (→ EmptyState).
 */
function computeRange(
  docs: DocumentSummary[],
  startField: string,
  endField: string,
  fallbackField: string,
): { start: string; end: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const doc of docs) {
    for (const field of [startField, endField, fallbackField]) {
      const key = bucketKey(doc.frontmatter[field]);
      if (key === null) continue;
      if (min === null || key < min) min = key;
      if (max === null || key > max) max = key;
    }
  }
  if (min === null || max === null) return null;
  // Pad one day each side so edge bars aren't flush against the boundary.
  return {
    start: isoOf(new Date(`${min}T00:00:00Z`).getTime() - DAY_MS),
    end: isoOf(new Date(`${max}T00:00:00Z`).getTime() + DAY_MS),
  };
}

/**
 * A droppable scale column. id = the column's startIso so onDragEnd's over.id
 * IS the target column's start date — the new start the dragged bar snaps to.
 * Rendered as the column header cell (the existing scale row).
 */
function TimeColumnDropzone({
  col,
  index,
  isToday,
  children,
}: {
  col: TimeColumn;
  index: number;
  isToday: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.startIso });
  return (
    <div
      ref={setNodeRef}
      data-testid="timeline-col"
      data-col-index={index}
      className={cn(
        'border-b border-border-light px-1 py-1 text-xs font-medium text-fg-3',
        isToday && 'text-primary',
        isOver && 'bg-primary/10',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A draggable timeline bar. id = doc.slug so onDragEnd's active.id resolves the
 * doc. Drag is gated behind PointerSensor's 5px activation distance so a plain
 * click opens the slideover instead of starting a drag.
 */
function TimelineBar({
  slug,
  title,
  className,
  style,
  onOpen,
}: {
  slug: string;
  title: string;
  className: string;
  style: React.CSSProperties;
  onOpen: (slug: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: slug });
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-testid={`timeline-bar-${slug}`}
      onClick={() => onOpen(slug)}
      title={title}
      style={style}
      className={cn(className, isDragging && 'opacity-40')}
      {...listeners}
      {...attributes}
    >
      {title}
    </button>
  );
}

export function TimelineView({ wslug, pslug, tslug, initialRange }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { view } = useActiveView(wslug, pslug, tslug);
  const update = useUpdateView(wslug, pslug, tslug);

  // Per-view config. settings is Record<string, unknown> — narrow each key.
  const fallbackField = settingString(view?.settings?.fallbackField, 'due_date');
  const startField = settingString(view?.settings?.startField, fallbackField);
  const endField = settingString(view?.settings?.endField, fallbackField);
  const zoom = settingZoom(view?.settings?.zoom);

  const {
    data: page,
    isLoading,
    error,
  } = useDocuments(wslug, pslug, tslug, { type: 'work_item', limit: 200 });

  const docs = useMemo(() => page?.data ?? [], [page]);

  const range = useMemo(
    () => initialRange ?? computeRange(docs, startField, endField, fallbackField),
    [initialRange, docs, startField, endField, fallbackField],
  );

  const scale = useMemo<TimeColumn[]>(
    () => (range ? buildTimeScale(range.start, range.end, zoom) : []),
    [range, zoom],
  );

  const fields = useMemo(
    () => ({ startField, endField, fallbackField }),
    [startField, endField, fallbackField],
  );

  const { placed } = useMemo(() => placeOnTimeline(docs, fields, scale), [docs, fields, scale]);

  const docsBySlug = useMemo(() => {
    const m = new Map<string, DocumentSummary>();
    for (const d of docs) m.set(d.slug, d);
    return m;
  }, [docs]);

  const updateDoc = useUpdateDocument(wslug, pslug, tslug, { type: 'work_item', limit: 200 });

  // 5px activation distance so a plain click on a bar opens the slideover and
  // never starts a drag. Mirrors the calendar/kanban sensor config.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // The slug currently dragged — drives the DragOverlay clone. Set on start,
  // cleared on end/cancel.
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  const onDragStart = (event: DragStartEvent) => setActiveSlug(String(event.active.id));
  const onDragCancel = () => setActiveSlug(null);

  // INVARIANT 16: the dragged dates are DOCUMENT attributes, so the drop writes
  // frontmatter on the DOCUMENT — NEVER the view. over.id is the target column's
  // startIso (TimeColumnDropzone id = col.startIso) = the bar's NEW start date.
  //
  // Range-preserving shift: compute the whole-DAY delta between the doc's CURRENT
  // start and the dropped column's start (NOT the column-index delta — at month
  // zoom a column spans many days). A single-date doc moves its one date field;
  // a range doc (BOTH start AND end valid) shifts BOTH ends by the SAME delta so
  // the duration is preserved. The patch sends ONLY the changed date keys — the
  // server merge-patches frontmatter (useUpdateDocument.mergeFrontmatter mirrors).
  const onDragEnd = async (event: DragEndEvent) => {
    setActiveSlug(null);
    const { active, over } = event;
    if (!over) return;
    const slug = String(active.id);
    const newStartIso = String(over.id);
    const doc = docsBySlug.get(slug);
    if (!doc) return;

    const startKey = bucketKey(doc.frontmatter[startField]);
    const endKey = bucketKey(doc.frontmatter[endField]);
    const fallbackKey = bucketKey(doc.frontmatter[fallbackField]);

    // A true range doc carries BOTH start AND end on the configured fields and
    // those fields differ from the fallback-only single-date case.
    const isRange = startField !== endField && startKey !== null && endKey !== null;

    if (isRange) {
      // startKey is non-null here (isRange guard). No-op if nothing moved.
      const current = startKey as string;
      if (newStartIso === current) return;
      const delta = dayDelta(current, newStartIso);
      const newEnd = shiftIso(endKey as string, delta);
      try {
        await updateDoc.mutateAsync({
          slug,
          patch: { frontmatter: { [startField]: newStartIso, [endField]: newEnd } },
        });
      } catch (err) {
        toast.error(formatApiError(err));
      }
      return;
    }

    // Single-date doc: write the new start to the active date field. Prefer the
    // fallback field (the calendar/placement primary), then whichever of
    // start/end carries the current date — mirrors placeOnTimeline's single-date
    // resolution so the drag writes the field the bar was placed by.
    const dateField =
      fallbackKey !== null ? fallbackField : startKey !== null ? startField : endField;
    const currentSingle = fallbackKey ?? startKey ?? endKey;
    if (newStartIso === currentSingle) return;
    try {
      await updateDoc.mutateAsync({
        slug,
        patch: { frontmatter: { [dateField]: newStartIso } },
      });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // The scale column index for today (for the vertical marker + jump button).
  // -1 when today falls outside the visible window.
  const todayIso = bucketKey(new Date().toISOString());
  const todayCol = useMemo(() => {
    if (todayIso === null) return -1;
    return scale.findIndex((c) => todayIso >= c.startIso && todayIso <= c.endIso);
  }, [scale, todayIso]);

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  // INVARIANT 16: zoom is a VIEW attribute (per-view config), so the write
  // targets the VIEW — useUpdateView PATCHes /views/:id — NEVER the document.
  // Spread the existing settings so startField/endField are preserved.
  const setZoom = async (nextZoom: TimelineZoom) => {
    if (!view || nextZoom === zoom) return;
    try {
      await update.mutateAsync({
        id: view.id,
        patch: { settings: { ...view.settings, zoom: nextZoom } },
      });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const jumpToday = () => {
    if (todayCol < 0) return;
    const el = document.querySelector(`[data-testid="timeline-col"][data-col-index="${todayCol}"]`);
    el?.scrollIntoView({ inline: 'center', behavior: 'smooth' });
  };

  if (isLoading) return <TimelineSkeleton />;
  if (error) return <div className="p-4 text-danger">Failed to load timeline.</div>;

  const isEmpty = scale.length === 0 || placed.length === 0;

  // Shared bar styling so a placed bar and its DragOverlay clone match.
  const barClass = (doc: DocumentSummary, clamped?: boolean) =>
    cn(
      'truncate rounded-md border px-2 py-1 text-left text-xs hover:brightness-110',
      barAccent(
        dueUrgency(
          doc.frontmatter[fallbackField] ??
            doc.frontmatter[startField] ??
            doc.frontmatter[endField],
        ),
      ),
      clamped && 'ring-1 ring-inset ring-warning/50',
    );
  const activeDoc = activeSlug ? (docsBySlug.get(activeSlug) ?? null) : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="flex h-full min-h-0 flex-col px-[22px] py-2">
        {/* Toolbar: zoom toggle + Today jump */}
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-base font-medium text-fg">Timeline</h2>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center rounded-md border border-border-light">
              {ZOOMS.map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => void setZoom(z)}
                  aria-pressed={z === zoom}
                  className={cn(
                    'px-2 py-1 text-sm first:rounded-l-md last:rounded-r-md',
                    z === zoom ? 'bg-card text-fg' : 'text-fg-2 hover:bg-card',
                  )}
                >
                  {ZOOM_LABELS[z]}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={jumpToday}
              disabled={todayCol < 0}
              className="rounded-md border border-border-light px-2 py-1 text-sm text-fg-2 hover:bg-card disabled:opacity-40"
            >
              Today
            </button>
          </div>
        </div>

        {isEmpty ? (
          <div data-testid="timeline-empty" className="flex-1">
            <EmptyState
              title="No dated work items"
              description="Work items with a date appear here as bars on the timeline."
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div
              className="relative grid gap-px"
              style={{
                gridTemplateColumns: `repeat(${scale.length}, minmax(64px, 1fr))`,
              }}
            >
              {/* Scale header — one droppable cell per column (id = startIso). */}
              {scale.map((col, i) => (
                <TimeColumnDropzone key={col.key} col={col} index={i} isToday={i === todayCol}>
                  {col.label}
                </TimeColumnDropzone>
              ))}

              {/* Today marker — a vertical line spanning the placed column. */}
              {todayCol >= 0 ? (
                <div
                  data-testid="timeline-today-marker"
                  aria-hidden
                  className="pointer-events-none z-10 w-px justify-self-center bg-primary/60"
                  style={{
                    gridColumn: `${todayCol + 1} / span 1`,
                    gridRow: `1 / span ${placed.length + 1}`,
                  }}
                />
              ) : null}

              {/* Bars — one row each, positioned by colStart / colSpan. */}
              {placed.map((bar) => {
                const doc = docsBySlug.get(bar.slug);
                if (!doc) return null;
                return (
                  <TimelineBar
                    key={bar.slug}
                    slug={bar.slug}
                    title={doc.title}
                    onOpen={openDoc}
                    style={{ gridColumn: `${bar.colStart + 1} / span ${bar.colSpan}` }}
                    className={barClass(doc, bar.clamped)}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
      {/* The dragged bar's clone. DragOverlay portals to the body so it escapes
          the scroll container's clip and paints on top of the grid. */}
      <DragOverlay>
        {activeDoc ? <div className={barClass(activeDoc)}>{activeDoc.title}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}
