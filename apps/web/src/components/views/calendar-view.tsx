import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useDocuments } from '../../lib/api/documents.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { type DueUrgency, dueUrgency } from '../../lib/due-urgency.ts';
import { cn } from '../ui/cn.ts';
import { buildMonthGrid, placeDocuments } from './calendar-grid.ts';
import { CalendarSkeleton } from './calendar-skeleton.tsx';
import { EmptyState } from './empty-state.tsx';

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

export function CalendarView({ wslug, pslug, tslug, initialMonth }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { view } = useActiveView(wslug, pslug, tslug);

  // Per-view placement field (default 'due_date' when unset). settings is
  // Record<string, unknown> — narrow before trusting it as a key.
  const dateField =
    typeof view?.settings?.dateField === 'string' ? view.settings.dateField : 'due_date';

  const [cursor, setCursor] = useState<{ year: number; month: number }>(
    () => initialMonth ?? currentMonth(),
  );

  const {
    data: page,
    isLoading,
    error,
  } = useDocuments(wslug, pslug, tslug, { type: 'work_item', limit: 200 });

  const docs = useMemo(() => page?.data ?? [], [page]);
  const grid = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);
  const { byDay, unscheduled } = useMemo(() => placeDocuments(docs, dateField), [docs, dateField]);

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
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

  return (
    <div className="flex h-full min-h-0 flex-col px-[22px] py-2">
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
            className="rounded-md border border-border-light px-2 py-1 text-sm text-fg-2 hover:bg-card"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={goToday}
            className="rounded-md border border-border-light px-2 py-1 text-sm text-fg-2 hover:bg-card"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={goNext}
            className="rounded-md border border-border-light px-2 py-1 text-sm text-fg-2 hover:bg-card"
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
            <div
              key={cell.iso}
              data-testid="calendar-day-cell"
              className={cn('min-h-[72px] bg-shell p-1', !cell.inMonth && 'bg-card/50 text-fg-3')}
            >
              <div data-testid={`calendar-cell-${cell.iso}`} className="flex h-full flex-col gap-1">
                <div className={cn('text-xs', cell.inMonth ? 'text-fg-2' : 'text-fg-3')}>
                  {cell.day}
                </div>
                {dayDocs.map((doc) => (
                  <button
                    key={doc.slug}
                    type="button"
                    onClick={() => openDoc(doc.slug)}
                    title={doc.title}
                    className={cn(
                      'truncate rounded-sm border bg-shell px-1.5 py-0.5 text-left text-xs hover:bg-card',
                      chipAccent(dueUrgency(doc.frontmatter[dateField])),
                    )}
                  >
                    {doc.title}
                  </button>
                ))}
              </div>
            </div>
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
              <button
                key={doc.slug}
                type="button"
                onClick={() => openDoc(doc.slug)}
                title={doc.title}
                className="truncate rounded-sm border border-border-light bg-shell px-1.5 py-0.5 text-left text-xs text-fg-2 hover:bg-card"
              >
                {doc.title}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
