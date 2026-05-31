import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
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

  it('column wraps cards in a sortable context when reorder is enabled', () => {
    render(
      <DndContext>
        <KanbanColumn value="todo" label="Todo" count={1} docIds={['d1']} reorderEnabled>
          <KanbanCard doc={sampleDoc()} onOpen={() => {}} sortable />
        </KanbanColumn>
      </DndContext>,
    );
    expect(screen.getByRole('button', { name: /Card A/ })).toBeTruthy();
  });

  it('column renders cards directly when reorder is disabled (sort active)', () => {
    render(
      <DndContext>
        <KanbanColumn value="todo" label="Todo" count={1} docIds={['d1']} reorderEnabled={false}>
          <KanbanCard doc={sampleDoc()} onOpen={() => {}} />
        </KanbanColumn>
      </DndContext>,
    );
    expect(screen.getByRole('button', { name: /Card A/ })).toBeTruthy();
  });
});
