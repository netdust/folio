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

  // Manual (drag) sort is PARKED — the Sort menu no longer offers a "Manual"
  // item. It must still offer the built-in sorts + the project's fields, and
  // selecting one fires onSortChange with the field's key (ascending first).
  test('sort control does NOT offer Manual but offers built-in + field sorts and fires onSortChange(key,dir)', () => {
    const onSortChange = vi.fn();
    render(<BoardToolbar groupBy="status" sort={{ key: 'updated_at', dir: 'desc' }} fields={fields as never} onGroupByChange={() => {}} onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    // Parked option is gone…
    expect(screen.queryByRole('menuitem', { name: /^manual$/i })).toBeNull();
    // …while the built-in sorts and the seeded field remain selectable.
    expect(screen.getByRole('menuitem', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Updated' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /priority/i })).toBeInTheDocument();
    // Selecting a fresh field starts ascending.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Title' }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'title', dir: 'asc' });
  });

  test('selecting a sort field fires onSortChange with key+dir', () => {
    const onSortChange = vi.fn();
    render(<BoardToolbar groupBy="status" sort={null} fields={fields as never} onGroupByChange={() => {}} onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /priority/i }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'priority', dir: 'asc' });
  });
});
