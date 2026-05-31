import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TableCell } from './table-cell.tsx';
import type { Column } from './columns.ts';
import type { DocumentSummary } from '../../lib/api/documents.ts';

function makeDoc(frontmatter: Record<string, unknown>): DocumentSummary {
  return {
    id: 'd1',
    slug: 'x',
    type: 'work_item',
    title: 'X',
    status: null,
    parentId: null,
    frontmatter,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

const noop = () => {};

describe('TableCell urgency', () => {
  it('renders the urgency class for ANY date field, not just next_action_due', () => {
    // The earlier implementation gated urgency on column.key === 'next_action_due'.
    // Stefan's CRM expects this to be generic — any field of type 'date'
    // should glow when overdue.
    const column: Column = {
      key: 'due_date',
      label: 'Due',
      source: 'field',
      fieldType: 'date',
      fieldOptions: null,
    };
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const doc = makeDoc({ due_date: yesterday });

    const { container } = render(
      <TableCell
        column={column}
        doc={doc}
        statuses={[]}
        isPending={false}
        onOpen={noop}
        onTitleCommit={noop}
        onStatusCommit={noop}
        onFieldCommit={noop}
      />,
    );

    // An overdue date must surface the text-danger class somewhere in the
    // rendered cell — that's the user-visible urgency cue.
    const hasDanger = container.querySelector('.text-danger') !== null;
    expect(hasDanger).toBe(true);
  });

  it('isSticky=true wraps the cell in a sticky container with a right border', () => {
    // The first column gets sticky positioning when the table scrolls
    // horizontally. To make the boundary between sticky and scrolling
    // columns visible, the sticky wrapper carries `border-r border-border-light`.
    const column: Column = {
      key: 'title',
      label: 'Title',
      source: 'builtin',
      fieldType: null,
      fieldOptions: null,
    };
    const doc = makeDoc({});
    const { container } = render(
      <TableCell
        column={column}
        doc={doc}
        statuses={[]}
        isPending={false}
        isSticky={true}
        onOpen={noop}
        onTitleCommit={noop}
        onStatusCommit={noop}
        onFieldCommit={noop}
      />,
    );

    const wrapper = container.firstElementChild;
    expect(wrapper).toBeTruthy();
    const cls = wrapper!.getAttribute('class') ?? '';
    expect(cls).toContain('sticky');
    expect(cls).toContain('left-0');
    expect(cls).toContain('border-r');
    expect(cls).toContain('border-border-light');
    // The sticky cell owns the 22px left whitespace so it stays pinned from
    // the first pixel of horizontal scroll. Without this, the row's left
    // gutter scrolls with the rest until the cell's left edge hits left:0.
    expect(cls).toContain('pl-[22px]');
  });

  it('isSticky=false does NOT add the sticky wrapper or right border', () => {
    const column: Column = {
      key: 'updated_at',
      label: 'Updated',
      source: 'builtin',
      fieldType: null,
      fieldOptions: null,
    };
    const doc = makeDoc({});
    const { container } = render(
      <TableCell
        column={column}
        doc={doc}
        statuses={[]}
        isPending={false}
        isSticky={false}
        onOpen={noop}
        onTitleCommit={noop}
        onStatusCommit={noop}
        onFieldCommit={noop}
      />,
    );

    // No wrapping `sticky` element — the content renders directly.
    const stickyEl = container.querySelector('.sticky');
    expect(stickyEl).toBeNull();
  });

  it('resolves relation titles when resolveRelation is provided (valid links are not struck-through)', () => {
    // Finding 9: the table relation cell used to render every [[slug]] as a
    // struck-through "broken-link" chip because TableCell never threaded a
    // resolver down to FieldRenderer. With resolveRelation supplied, a slug
    // that resolves must render as the document's title (normal chip) and a
    // slug that does NOT resolve stays struck-through.
    const column: Column = {
      key: 'owner',
      label: 'Owner',
      source: 'field',
      fieldType: 'relation',
      fieldOptions: ['table:tbl_1', 'multi'],
    };
    const doc = makeDoc({ owner: ['[[people-ada]]', '[[ghost]]'] });
    const { container } = render(
      <TableCell
        column={column}
        doc={doc}
        statuses={[]}
        isPending={false}
        onOpen={noop}
        onTitleCommit={noop}
        onStatusCommit={noop}
        onFieldCommit={noop}
        resolveRelation={(slug) =>
          slug === 'people-ada' ? { slug, title: 'Ada' } : null
        }
      />,
    );

    // The resolved link renders as a title chip, NOT struck-through.
    const ada = container.querySelector('button');
    expect(ada?.textContent).toBe('Ada');
    expect(ada?.getAttribute('class') ?? '').not.toContain('line-through');
    // The unresolved link stays as the raw token, struck through.
    const struck = [...container.querySelectorAll('span')].find(
      (el) => el.textContent === '[[ghost]]',
    );
    expect(struck?.getAttribute('class') ?? '').toContain('line-through');
  });

  it('does NOT apply urgency to non-date field columns', () => {
    const column: Column = {
      key: 'amount',
      label: 'Amount',
      source: 'field',
      fieldType: 'currency',
      fieldOptions: ['EUR'],
    };
    const doc = makeDoc({ amount: 1250 });
    const { container } = render(
      <TableCell
        column={column}
        doc={doc}
        statuses={[]}
        isPending={false}
        onOpen={noop}
        onTitleCommit={noop}
        onStatusCommit={noop}
        onFieldCommit={noop}
      />,
    );
    expect(container.querySelector('.text-danger')).toBeNull();
    expect(container.querySelector('.text-warning')).toBeNull();
  });
});
