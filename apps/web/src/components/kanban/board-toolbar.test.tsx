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

  test('sort control offers Manual + fields and fires onSortChange(null) for Manual', () => {
    const onSortChange = vi.fn();
    render(<BoardToolbar groupBy="status" sort={{ key: 'updated_at', dir: 'desc' }} fields={fields as never} onGroupByChange={() => {}} onSortChange={onSortChange} />);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /manual/i }));
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
