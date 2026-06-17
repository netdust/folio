import { DndContext } from '@dnd-kit/core';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import { KanbanCard } from './kanban-card.tsx';
import { KanbanColumn } from './kanban-column.tsx';

function sampleDoc(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: 'd1',
    slug: 'card-a',
    type: 'work_item',
    title: 'Card A',
    status: 'todo',
    parentId: null,
    frontmatter: {},
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    lastTouchedAt: null,
    ...overrides,
  };
}

function renderCard(doc: DocumentSummary = sampleDoc()) {
  return render(
    <DndContext>
      <KanbanCard doc={doc} onOpen={() => {}} />
    </DndContext>,
  );
}

describe('KanbanCard', () => {
  // Bug G (2026-05-26): the card used bg-shell with hover:bg-card. On the
  // kanban column's tinted body (~+3% white overlay), shell→card was nearly
  // invisible. The base is now bg-content so the card lifts off the column
  // body, and hover keeps the +1 step to bg-card so the hover-bg delta is
  // visible against the lifted base.
  it('renders with bg-content as the base background', () => {
    renderCard();
    const card = screen.getByRole('button', { name: /Card A/ });
    expect(card.className).toContain('bg-content');
  });

  it('has hover:bg-card for a clearer hover step', () => {
    renderCard();
    const card = screen.getByRole('button', { name: /Card A/ });
    expect(card.className).toContain('hover:bg-card');
  });

  it('has hover:border-fg-3 so the border lifts on hover', () => {
    renderCard();
    const card = screen.getByRole('button', { name: /Card A/ });
    expect(card.className).toContain('hover:border-fg-3');
  });

  // Mode-switch smoke tests: jsdom can't realistically fire dnd-kit's DragEnd,
  // so the reorder math is unit-tested in board-reorder.test.ts. Here we only
  // prove the card+column render in both board modes without crashing.
  it('renders a sortable card (manual mode) without crashing', () => {
    render(
      <DndContext>
        <KanbanCard doc={sampleDoc()} onOpen={() => {}} sortable />
      </DndContext>,
    );
    expect(screen.getByRole('button', { name: /Card A/ })).toBeTruthy();
  });

  it('column wraps cards in a sortable context when sortable', () => {
    render(
      <DndContext>
        <KanbanColumn value="todo" label="Todo" count={1} docIds={['d1']} sortable>
          <KanbanCard doc={sampleDoc()} onOpen={() => {}} sortable />
        </KanbanColumn>
      </DndContext>,
    );
    expect(screen.getByRole('button', { name: /Card A/ })).toBeTruthy();
  });

  it('column renders cards directly when not sortable', () => {
    render(
      <DndContext>
        <KanbanColumn value="todo" label="Todo" count={1} docIds={['d1']} sortable={false}>
          <KanbanCard doc={sampleDoc()} onOpen={() => {}} />
        </KanbanColumn>
      </DndContext>,
    );
    expect(screen.getByRole('button', { name: /Card A/ })).toBeTruthy();
  });

  // The drop-line is rendered by KanbanColumn as a flex SIBLING between cards
  // (moved out of the card so it doesn't follow the sliding cards). jsdom has no
  // layout, so these only prove the line ELEMENT is interleaved at the right slot
  // and absent without an indicator — positioning/no-follow is the browser pass.
  function renderColumn(indicator: { overId: string; edge: 'top' | 'bottom' } | null) {
    return render(
      <DndContext>
        <KanbanColumn
          value="todo"
          label="Todo"
          count={2}
          docIds={['d1', 'd2']}
          indicator={indicator}
          sortable
        >
          <KanbanCard doc={sampleDoc({ id: 'd1', title: 'Card A' })} onOpen={() => {}} sortable />
          <KanbanCard doc={sampleDoc({ id: 'd2', title: 'Card B' })} onOpen={() => {}} sortable />
        </KanbanColumn>
      </DndContext>,
    );
  }

  it('column renders the drop-line when an indicator is set', () => {
    renderColumn({ overId: 'd1', edge: 'bottom' });
    expect(screen.getByTestId('drop-line')).toBeTruthy();
  });

  it('column renders NO drop-line without an indicator', () => {
    renderColumn(null);
    expect(screen.queryByTestId('drop-line')).toBeNull();
  });

  it('places the line AFTER the over-card on edge "bottom"', () => {
    const { container } = renderColumn({ overId: 'd1', edge: 'bottom' });
    // Order within the column body: Card A, line, Card B.
    const body = container.querySelector('[data-testid="kanban-column-body"]');
    const texts = [
      ...(body?.querySelectorAll('[data-testid="drop-line"], .font-medium') ?? []),
    ].map((el) => el.getAttribute('data-testid') ?? el.textContent);
    expect(texts).toEqual(['Card A', 'drop-line', 'Card B']);
  });

  it('places the line BEFORE the over-card on edge "top"', () => {
    const { container } = renderColumn({ overId: 'd2', edge: 'top' });
    const body = container.querySelector('[data-testid="kanban-column-body"]');
    const texts = [
      ...(body?.querySelectorAll('[data-testid="drop-line"], .font-medium') ?? []),
    ].map((el) => el.getAttribute('data-testid') ?? el.textContent);
    expect(texts).toEqual(['Card A', 'drop-line', 'Card B']);
  });
});

// Bug 1 (2026-06-07): after a within-column drop the dragged card visibly slid
// BACK toward its origin slot. Root cause: SortableCard always applied
// dnd-kit's leftover transform + `transition`, so on drop the transition
// animated the in-place node home (the DragOverlay clone is the visible one, so
// the underlying node should be inert). The fix gates the dragged item's
// transform/transition behind isDragging. jsdom can't run a real drag, so we
// mock useSortable to return the dragging shape and assert the rendered node
// carries NO animating transition (and no leftover transform to animate FROM).
describe('SortableCard dragged-node inertness (no animate-back)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('renders the dragged in-place node with transition:none and no transform', async () => {
    vi.resetModules();
    vi.doMock('@dnd-kit/sortable', () => ({
      useSortable: () => ({
        attributes: {},
        listeners: {},
        setNodeRef: () => {},
        // A leftover transform + transition like dnd-kit keeps post-drop —
        // exactly the pair that animated the card home before the fix.
        transform: { x: 0, y: -68, scaleX: 1, scaleY: 1 },
        transition: 'transform 200ms ease',
        isDragging: true,
      }),
      SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
      verticalListSortingStrategy: undefined,
    }));
    const { KanbanCard: MockedCard } = await import('./kanban-card.tsx');
    render(
      <DndContext>
        <MockedCard doc={sampleDoc()} onOpen={() => {}} sortable />
      </DndContext>,
    );
    const card = screen.getByRole('button', { name: /Card A/ });
    // The leftover 'transform 200ms' transition is what slid the card back.
    expect(card.style.transition === 'none' || card.style.transition === '').toBe(true);
    expect(card.style.transition).not.toContain('200ms');
    // No leftover transform on the in-place node → nothing to animate FROM.
    expect(card.style.transform === '' || card.style.transform == null).toBe(true);
    // It is hidden — the DragOverlay clone is the visible drag element.
    expect(card.style.opacity).toBe('0');
  });

  it('keeps a non-dragging sortable card animating its shift-to-make-room', async () => {
    vi.resetModules();
    vi.doMock('@dnd-kit/sortable', () => ({
      useSortable: () => ({
        attributes: {},
        listeners: {},
        setNodeRef: () => {},
        transform: { x: 0, y: 40, scaleX: 1, scaleY: 1 },
        transition: 'transform 200ms ease',
        isDragging: false,
      }),
      SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
      verticalListSortingStrategy: undefined,
    }));
    const { KanbanCard: MockedCard } = await import('./kanban-card.tsx');
    render(
      <DndContext>
        <MockedCard doc={sampleDoc()} onOpen={() => {}} sortable />
      </DndContext>,
    );
    const card = screen.getByRole('button', { name: /Card A/ });
    // Other (non-dragged) cards SHOULD still animate their shift to make room.
    expect(card.style.transition).toContain('200ms');
    expect(card.style.transform).toContain('translate');
    expect(card.style.opacity).not.toBe('0');
  });
});
