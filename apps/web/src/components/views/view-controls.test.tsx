import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Field } from '../../lib/api/fields.ts';
import type { View } from '../../lib/api/views.ts';

// ---------------------------------------------------------------------------
// Shared mock state. ViewControls reuses the same API hooks as TableView /
// ListControls / BoardControls; we drive them through module-level mocks so a
// single component can be exercised across every view type.
// ---------------------------------------------------------------------------

let activeView: View;

const mutateSpy = vi.fn();
const updateDocumentMutateSpy = vi.fn();
const navigateSpy = vi.fn();
let currentSearch: Record<string, unknown> = {};

function makeView(overrides: Partial<View>): View {
  return {
    id: 'v1',
    name: 'A view',
    type: 'table',
    filters: {},
    sort: null,
    groupBy: null,
    visibleFields: null,
    columnOrder: null,
    settings: {},
    isDefault: true,
    order: 0,
    ...overrides,
  };
}

const fields: Field[] = [
  {
    id: 'f1',
    key: 'priority',
    type: 'select',
    label: 'Priority',
    options: ['Low', 'High'],
    required: false,
    order: 1,
  },
  {
    id: 'f2',
    key: 'start_date',
    type: 'date',
    label: 'Start date',
    options: null,
    required: false,
    order: 2,
  },
  {
    id: 'f3',
    key: 'end_date',
    type: 'datetime',
    label: 'End date',
    options: null,
    required: false,
    order: 3,
  },
];

const statuses = [
  {
    id: 's1',
    key: 'todo',
    name: 'Todo',
    color: '#3b82f6',
    category: 'unstarted' as const,
    order: 0,
  },
];

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateSpy,
  useSearch: () => currentSearch,
}));

vi.mock('../../lib/api/use-active-view.ts', () => ({
  useActiveView: () => ({ view: activeView, views: [activeView], isLoading: false }),
}));

vi.mock('../../lib/api/views.ts', () => ({
  useUpdateView: () => ({ mutate: mutateSpy, mutateAsync: mutateSpy }),
  useViews: () => ({ data: [activeView] }),
}));

vi.mock('../../lib/api/fields.ts', () => ({
  useFields: () => ({ data: fields }),
}));

vi.mock('../../lib/api/statuses.ts', () => ({
  useStatuses: () => ({ data: statuses }),
}));

// If a FILTER or SETTINGS change ever wrote a document, this fires — asserting
// it is NEVER called is the negative half of every Tier-A slice.
vi.mock('../../lib/api/documents.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/documents.ts')>(
    '../../lib/api/documents.ts',
  );
  return { ...actual, useUpdateDocument: () => ({ mutate: updateDocumentMutateSpy }) };
});

// The board bus is module-global; stub it so BoardControls (the kanban slot) is
// inert in jsdom.
vi.mock('../../lib/board-controls-bus.ts', () => ({
  boardControlsBus: {
    subscribe: () => () => {},
    get: () => undefined,
    setGroupBy: vi.fn(),
    setSort: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { ViewControls } from './view-controls.tsx';

function renderControls() {
  return render(<ViewControls wslug="main" pslug="acme" tslug="work-items" />);
}

const ALL_TYPES: View['type'][] = ['table', 'list', 'kanban', 'calendar', 'timeline'];

describe('ViewControls', () => {
  beforeEach(() => {
    mutateSpy.mockClear();
    updateDocumentMutateSpy.mockClear();
    navigateSpy.mockClear();
    currentSearch = {};
    activeView = makeView({ type: 'table' });
  });

  afterEach(() => vi.clearAllMocks());

  describe('shared FilterBar on every view type', () => {
    for (const type of ALL_TYPES) {
      it(`renders the FilterBar for a ${type} view (same component everywhere)`, () => {
        activeView = makeView({ type });
        renderControls();
        expect(screen.getByTestId('filter-bar')).toBeInTheDocument();
      });
    }
  });

  describe('per-type settings slot', () => {
    it('kanban → exposes the BoardControls group-by + sort triggers', () => {
      activeView = makeView({ type: 'kanban', groupBy: 'status' });
      renderControls();
      // BoardControls renders the board toolbar: a "Group:" + a "Sort:" trigger.
      expect(screen.getByText('Group:')).toBeInTheDocument();
      expect(screen.getByText('Sort:')).toBeInTheDocument();
    });

    it('list → exposes group-by + aggregate controls', () => {
      activeView = makeView({
        type: 'list',
        settings: { groupBy: 'status', aggregates: [{ op: 'count' }] },
      });
      renderControls();
      expect(screen.getByLabelText(/Group by/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Aggregation 1/i)).toBeInTheDocument();
    });

    it('table → renders NO extra settings slot (filter only)', () => {
      activeView = makeView({ type: 'table' });
      renderControls();
      expect(screen.queryByLabelText(/Group by/i)).toBeNull();
      expect(screen.queryByLabelText(/Date field/i)).toBeNull();
    });

    it('calendar → exposes a date-field select reading settings.dateField', () => {
      activeView = makeView({ type: 'calendar', settings: { dateField: 'start_date' } });
      renderControls();
      const dateField = screen.getByLabelText(/Date field/i) as HTMLSelectElement;
      expect(dateField.value).toBe('start_date');
      // The project's date/datetime fields are options, plus the due_date default.
      expect(within(dateField).getByRole('option', { name: 'Start date' })).toBeInTheDocument();
      expect(within(dateField).getByRole('option', { name: 'End date' })).toBeInTheDocument();
    });

    it('timeline → exposes zoom toggle + start/end field selects', () => {
      activeView = makeView({
        type: 'timeline',
        settings: { zoom: 'week', startField: 'start_date', endField: 'end_date' },
      });
      renderControls();
      expect(screen.getByRole('button', { name: /^day$/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/Start field/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/End field/i)).toBeInTheDocument();
    });
  });

  describe('Tier-A slice 1: a FILTER change writes the VIEW, never a document', () => {
    it('adding a status filter PATCHes the active view via useUpdateView (patch.filters)', async () => {
      // ?view= consent gate: the user has explicitly opened this view.
      currentSearch = { view: 'v1' };
      activeView = makeView({ id: 'v1', type: 'table' });
      renderControls();

      // Open the FilterAdd popover (trigger label "+ Filter") and pick status.
      await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
      await userEvent.click(await screen.findByText('Status'));
      await userEvent.click(await screen.findByText('Todo'));

      expect(mutateSpy).toHaveBeenCalled();
      const [arg] = mutateSpy.mock.calls.at(-1) ?? [];
      expect(arg).toMatchObject({ id: 'v1' });
      expect(arg.patch).toHaveProperty('filters');
      // NEVER a document write on a filter change.
      expect(updateDocumentMutateSpy).not.toHaveBeenCalled();
    });

    it('does NOT autosave a filter change without ?view= (ad-hoc, no consent)', async () => {
      currentSearch = {}; // no ?view= → activeView is a fallback.
      activeView = makeView({ id: 'v1', type: 'table' });
      renderControls();

      await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
      await userEvent.click(await screen.findByText('Status'));
      await userEvent.click(await screen.findByText('Todo'));

      // Navigated (URL changes), but the view was NOT mutated.
      expect(navigateSpy).toHaveBeenCalled();
      expect(mutateSpy).not.toHaveBeenCalled();
      expect(updateDocumentMutateSpy).not.toHaveBeenCalled();
    });
  });

  describe('Tier-A slice 2: a SETTINGS change writes the VIEW, never a document', () => {
    it('calendar date-field change PATCHes settings.dateField on the view', async () => {
      activeView = makeView({ id: 'v1', type: 'calendar', settings: { dateField: 'due_date' } });
      renderControls();

      await userEvent.selectOptions(screen.getByLabelText(/Date field/i), 'start_date');

      expect(mutateSpy).toHaveBeenCalled();
      const [arg] = mutateSpy.mock.calls.at(-1) ?? [];
      expect(arg).toMatchObject({ id: 'v1' });
      expect((arg.patch.settings as { dateField: string }).dateField).toBe('start_date');
      expect(updateDocumentMutateSpy).not.toHaveBeenCalled();
    });

    it('timeline zoom change PATCHes settings.zoom on the view (preserving siblings)', async () => {
      activeView = makeView({
        id: 'v1',
        type: 'timeline',
        settings: { zoom: 'week', startField: 'start_date' },
      });
      renderControls();

      await userEvent.click(screen.getByRole('button', { name: /^day$/i }));

      expect(mutateSpy).toHaveBeenCalled();
      const [arg] = mutateSpy.mock.calls.at(-1) ?? [];
      const settings = arg.patch.settings as Record<string, unknown>;
      expect(settings.zoom).toBe('day');
      // Spread of existing settings — startField is not dropped.
      expect(settings.startField).toBe('start_date');
      expect(updateDocumentMutateSpy).not.toHaveBeenCalled();
    });
  });

  it('renders nothing when there is no active view', () => {
    // @ts-expect-error — exercising the no-view guard.
    activeView = undefined;
    const { container } = renderControls();
    expect(container).toBeEmptyDOMElement();
  });
});
