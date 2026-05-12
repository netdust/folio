import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterBar } from './filter-bar.tsx';

const STATUSES = [
  { id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted' as const, order: 1 },
  { id: 's2', key: 'doing', name: 'In progress', color: '#F0A442', category: 'started' as const, order: 2 },
];

describe('FilterBar', () => {
  it('renders applied chips with remove buttons', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        clauses={[{ kind: 'status', values: ['todo'] }]}
        statuses={STATUSES}
        pinnedFields={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove status filter/i })).toBeInTheDocument();
  });

  it('clicking remove fires onChange without the removed clause', async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        clauses={[{ kind: 'status', values: ['todo'] }, { kind: 'priority', value: 'high' }]}
        statuses={STATUSES}
        pinnedFields={[
          {
            id: 'f1',
            key: 'priority',
            type: 'select',
            label: null,
            options: ['low', 'high'],
            required: false,
            order: 0,
          },
        ]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Remove status filter/i }));
    expect(onChange).toHaveBeenCalledWith([{ kind: 'priority', value: 'high' }]);
  });

  it('Add Filter popover offers Status → status options → adds clause', async () => {
    const onChange = vi.fn();
    render(<FilterBar clauses={[]} statuses={STATUSES} pinnedFields={[]} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    await userEvent.click(await screen.findByText('Status'));
    await userEvent.click(await screen.findByText('Todo'));
    expect(onChange).toHaveBeenCalledWith([{ kind: 'status', values: ['todo'] }]);
  });
});
