import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Field } from '../../lib/api/fields.ts';
import type { View } from '../../lib/api/views.ts';

// The active list view under edit: group-by `status`, one count aggregate.
const activeView: View = {
  id: 'v1',
  name: 'My list',
  type: 'list',
  filters: null,
  sort: null,
  groupBy: null,
  visibleFields: null,
  columnOrder: null,
  settings: {
    groupBy: 'status',
    aggregates: [{ op: 'count' }],
    rowLayout: { primary: 'title', fields: [] },
  },
  isDefault: true,
  order: 0,
};

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
    key: 'estimate',
    type: 'number',
    label: 'Estimate',
    options: null,
    required: false,
    order: 2,
  },
  {
    id: 'f3',
    key: 'labels',
    type: 'multi_select',
    label: 'Labels',
    options: ['bug'],
    required: false,
    order: 3,
  },
];

// Spy on the update-view mutate. This is the Tier-A slice: a settings change
// MUST flow through useUpdateView (PATCH /views/:id), NEVER a document write.
const mutateSpy = vi.fn();
const updateDocumentMutateSpy = vi.fn();

vi.mock('../../lib/api/use-active-view.ts', () => ({
  useActiveView: () => ({ view: activeView, views: [activeView], isLoading: false }),
}));

vi.mock('../../lib/api/fields.ts', () => ({
  useFields: () => ({ data: fields }),
}));

vi.mock('../../lib/api/views.ts', () => ({
  useUpdateView: () => ({ mutate: mutateSpy }),
}));

// If ListControls ever wrote a document on a settings change, this would fire —
// asserting it is NEVER called is the negative half of the Tier-A slice.
vi.mock('../../lib/api/documents.ts', () => ({
  useUpdateDocument: () => ({ mutate: updateDocumentMutateSpy }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { ListControls } from './list-controls.tsx';

function renderControls() {
  return render(<ListControls wslug="main" pslug="acme" tslug="work-items" />);
}

// Open the group-by pill popover and return the menu container. The pill mirrors
// the board's "Group:" trigger; its items are role="menuitem" buttons.
function openGroupMenu() {
  fireEvent.click(screen.getByRole('button', { name: /group/i }));
}

// Open the aggregates pill popover (which now hosts the AggregateBuilder).
function openAggregates() {
  fireEvent.click(screen.getByRole('button', { name: /aggregates/i }));
}

describe('ListControls', () => {
  beforeEach(() => {
    mutateSpy.mockClear();
    updateDocumentMutateSpy.mockClear();
  });

  it('renders a group-by pill reflecting settings.groupBy; menu lists Status + groupable fields (multi_select excluded)', () => {
    renderControls();
    // The pill shows the current group-by label (Status) like the board does.
    const trigger = screen.getByRole('button', { name: /group/i });
    expect(within(trigger).getByText('Status')).toBeInTheDocument();

    openGroupMenu();
    expect(screen.getByRole('menuitem', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Priority' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Estimate' })).toBeInTheDocument();
    // multi_select is NOT groupable.
    expect(screen.queryByRole('menuitem', { name: 'Labels' })).toBeNull();
  });

  it('persists a group-by change to the ACTIVE VIEW via useUpdateView (Tier-A slice: writes the view)', () => {
    renderControls();
    openGroupMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Priority' }));

    expect(mutateSpy).toHaveBeenCalled();
    const [arg] = mutateSpy.mock.calls.at(-1) ?? [];
    expect(arg).toMatchObject({
      id: 'v1',
      patch: { settings: { groupBy: 'priority', aggregates: [{ op: 'count' }] } },
    });
    // NEVER a document write on a settings change.
    expect(updateDocumentMutateSpy).not.toHaveBeenCalled();
  });

  it('aggregate op select (inside the Aggregates popover) lists EXACTLY the AGGREGATIONS whitelist (sibling-site guard)', () => {
    renderControls();
    openAggregates();
    const opSelect = screen.getByLabelText(/Aggregation 1/i);
    for (const op of ['count', 'pct_matching', 'avg', 'sum', 'distribution']) {
      expect(within(opSelect).getByRole('option', { name: op })).toBeInTheDocument();
    }
    expect(within(opSelect).getAllByRole('option')).toHaveLength(5);
  });

  it('persists an added aggregate to settings.aggregates via useUpdateView', async () => {
    renderControls();
    openAggregates();
    await userEvent.click(screen.getByRole('button', { name: /Add aggregate/i }));

    expect(mutateSpy).toHaveBeenCalled();
    const [arg] = mutateSpy.mock.calls.at(-1) ?? [];
    // The new (count) aggregate landed alongside the existing one, on the view.
    expect(arg).toMatchObject({ id: 'v1' });
    expect((arg.patch.settings as { aggregates: unknown[] }).aggregates).toHaveLength(2);
    expect(updateDocumentMutateSpy).not.toHaveBeenCalled();
  });

  it('does NOT persist an incomplete aggregate (avg with no field) — I-2 pruning preserved', async () => {
    renderControls();
    openAggregates();
    // Switch the only row to avg without picking a field → incomplete.
    await userEvent.selectOptions(screen.getByLabelText(/Aggregation 1/i), 'avg');

    expect(mutateSpy).toHaveBeenCalled();
    const [arg] = mutateSpy.mock.calls.at(-1) ?? [];
    const persisted = (arg.patch.settings as { aggregates: { op: string }[] }).aggregates;
    // The incomplete avg never reaches the view's settings.
    expect(persisted.some((a) => a.op === 'avg')).toBe(false);
    // The row still renders in the UI so the user can finish it.
    expect(screen.getByLabelText(/Aggregate field 1/i)).toBeInTheDocument();
  });
});
