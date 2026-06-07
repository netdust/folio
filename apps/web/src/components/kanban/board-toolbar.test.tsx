import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BoardToolbar } from './board-toolbar.tsx';

const fields = [{ id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'] }];

describe('BoardToolbar', () => {
  test('group-by control lists Status + groupable fields and fires onGroupByChange', () => {
    const onGroupByChange = vi.fn();
    render(<BoardToolbar groupBy="status" sort={null} fields={fields as never} onGroupByChange={onGroupByChange} onSortChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /group/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /priority/i }));
    expect(onGroupByChange).toHaveBeenCalledWith('priority');
  });

  // 4c: Manual (drag) sort is UN-PARKED — the Sort menu offers a "Manual" item
  // again, alongside the built-in sorts + the project's fields. Selecting a
  // field fires onSortChange with the field's key (ascending first).
  test('sort control offers Manual + built-in + field sorts and fires onSortChange(key,dir)', () => {
    const onSortChange = vi.fn();
    render(<BoardToolbar groupBy="status" sort={{ key: 'updated_at', dir: 'desc' }} fields={fields as never} onGroupByChange={() => {}} onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    // Manual is back…
    expect(screen.getByRole('menuitem', { name: /^manual$/i })).toBeInTheDocument();
    // …while the built-in sorts and the seeded field remain selectable.
    expect(screen.getByRole('menuitem', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Updated' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /priority/i })).toBeInTheDocument();
    // Selecting a fresh field starts ascending.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Title' }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'title', dir: 'asc' });
  });

  // 4c: selecting Manual fires onSortChange(null) — null = board_position order.
  test('selecting Manual fires onSortChange(null)', () => {
    const onSortChange = vi.fn();
    render(<BoardToolbar groupBy="status" sort={{ key: 'title', dir: 'asc' }} fields={fields as never} onGroupByChange={() => {}} onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^manual$/i }));
    expect(onSortChange).toHaveBeenCalledWith(null);
  });

  test('selecting a sort field fires onSortChange with key+dir', () => {
    const onSortChange = vi.fn();
    render(<BoardToolbar groupBy="status" sort={null} fields={fields as never} onGroupByChange={() => {}} onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /priority/i }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'priority', dir: 'asc' });
  });
});
