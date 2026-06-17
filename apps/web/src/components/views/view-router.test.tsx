import { render, screen } from '@testing-library/react';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { ViewRouter } from './view-router.tsx';

// Mock the active-view resolver so the test asserts ROUTING, not resolution.
vi.mock('../../lib/api/use-active-view.ts', () => ({ useActiveView: vi.fn() }));

// Mock the two real renderers to stable markers so the test asserts which
// renderer the type maps to, not what those renderers actually draw.
vi.mock('../table/table-view.tsx', () => ({
  TableView: () => <div data-testid="table-view-marker" />,
}));
vi.mock('./kanban-view.tsx', () => ({
  KanbanView: () => <div data-testid="kanban-view-marker" />,
}));
vi.mock('./grouped-list-view.tsx', () => ({
  GroupedListView: () => <div data-testid="grouped-list-view-marker" />,
}));
vi.mock('./calendar-view.tsx', () => ({
  CalendarView: () => <div data-testid="calendar-view-marker" />,
}));

const mockUseActiveView = useActiveView as unknown as Mock;

function setView(type: string) {
  mockUseActiveView.mockReturnValue({
    view: { id: 'v1', type },
    views: [],
    isLoading: false,
  });
}

describe('ViewRouter', () => {
  beforeEach(() => {
    mockUseActiveView.mockReset();
  });

  it('routes type:table → TableView', () => {
    setView('table');
    render(<ViewRouter wslug="w" pslug="p" tslug="work-items" />);
    expect(screen.getByTestId('table-view-marker')).toBeInTheDocument();
  });

  it('routes type:kanban → KanbanView', () => {
    setView('kanban');
    render(<ViewRouter wslug="w" pslug="p" tslug="work-items" />);
    expect(screen.getByTestId('kanban-view-marker')).toBeInTheDocument();
  });

  it('routes type:calendar → CalendarView (cluster 4)', () => {
    setView('calendar');
    render(<ViewRouter wslug="w" pslug="p" tslug="work-items" />);
    expect(screen.getByTestId('calendar-view-marker')).toBeInTheDocument();
  });

  it('routes type:list → GroupedListView (cluster 2b)', () => {
    setView('list');
    render(<ViewRouter wslug="w" pslug="p" tslug="work-items" />);
    expect(screen.getByTestId('grouped-list-view-marker')).toBeInTheDocument();
  });

  // Denial / graceful-degradation path: a type with no dedicated renderer must
  // fall back to UnsupportedView and NOT crash.
  it('routes an unsupported type (gallery) → its UnsupportedView fallback, no crash', () => {
    setView('gallery');
    render(<ViewRouter wslug="w" pslug="p" tslug="work-items" />);
    expect(screen.getByTestId('unsupported-gallery')).toBeInTheDocument();
  });

  it('shows a loading state while the view list resolves', () => {
    mockUseActiveView.mockReturnValue({ view: undefined, views: [], isLoading: true });
    render(<ViewRouter wslug="w" pslug="p" tslug="work-items" />);
    expect(screen.getByText(/loading view/i)).toBeInTheDocument();
  });
});
