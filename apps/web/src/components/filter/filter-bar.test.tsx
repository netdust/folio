import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from './filter-bar.tsx';

const STATUSES = [
  {
    id: 's1',
    key: 'todo',
    name: 'Todo',
    color: '#6EAFFF',
    category: 'unstarted' as const,
    order: 1,
  },
  {
    id: 's2',
    key: 'doing',
    name: 'In progress',
    color: '#F0A442',
    category: 'started' as const,
    order: 2,
  },
];

describe('FilterBar', () => {
  it('renders applied chips with remove buttons', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        clauses={[{ kind: 'status', values: ['todo'] }]}
        statuses={STATUSES}
        filterableFields={[]}
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
        clauses={[
          { kind: 'status', values: ['todo'] },
          { kind: 'priority', value: 'high' },
        ]}
        statuses={STATUSES}
        filterableFields={[
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
    render(
      <FilterBar clauses={[]} statuses={STATUSES} filterableFields={[]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    await userEvent.click(await screen.findByText('Status'));
    await userEvent.click(await screen.findByText('Todo'));
    expect(onChange).toHaveBeenCalledWith([{ kind: 'status', values: ['todo'] }]);
  });

  it('offers a custom select field → its options → adds a field clause ($eq)', async () => {
    const onChange = vi.fn();
    const roleField = {
      id: 'f-role',
      key: 'role',
      type: 'select' as const,
      label: 'Role',
      options: ['performer', 'technician'],
      required: false,
      order: 0,
    };
    render(
      <FilterBar
        clauses={[]}
        statuses={STATUSES}
        filterableFields={[roleField]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    await userEvent.click(await screen.findByText('Role'));
    await userEvent.click(await screen.findByText('performer'));
    expect(onChange).toHaveBeenCalledWith([
      { kind: 'field', key: 'role', op: '$eq', value: 'performer', valueType: 'string' },
    ]);
  });

  it('a multi_select field adds a $contains field clause', async () => {
    const onChange = vi.fn();
    const dietField = {
      id: 'f-diet',
      key: 'diet_tags',
      type: 'multi_select' as const,
      label: 'Diet',
      options: ['veggie', 'glutenvrij'],
      required: false,
      order: 0,
    };
    render(
      <FilterBar
        clauses={[]}
        statuses={STATUSES}
        filterableFields={[dietField]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    await userEvent.click(await screen.findByText('Diet'));
    await userEvent.click(await screen.findByText('veggie'));
    expect(onChange).toHaveBeenCalledWith([
      { kind: 'field', key: 'diet_tags', op: '$contains', value: 'veggie', valueType: 'string' },
    ]);
  });

  it('a boolean field offers true/false and adds a boolean-typed clause', async () => {
    const onChange = vi.fn();
    const drivesField = {
      id: 'f-drives',
      key: 'drives',
      type: 'boolean' as const,
      label: 'Drives',
      options: null,
      required: false,
      order: 0,
    };
    render(
      <FilterBar
        clauses={[]}
        statuses={STATUSES}
        filterableFields={[drivesField]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    await userEvent.click(await screen.findByText('Drives'));
    await userEvent.click(await screen.findByText('true'));
    // valueType:'boolean' is what makes clausesToFilterJson coerce to a real
    // boolean — the drives=true-returns-nothing bug.
    expect(onChange).toHaveBeenCalledWith([
      { kind: 'field', key: 'drives', op: '$eq', value: 'true', valueType: 'boolean' },
    ]);
  });

  it('removing one of two field chips keeps the other (keyed by field key)', async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        clauses={[
          { kind: 'field', key: 'role', op: '$eq', value: 'performer' },
          { kind: 'field', key: 'org', op: '$eq', value: 'extern' },
        ]}
        statuses={STATUSES}
        filterableFields={[]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Remove role filter/i }));
    expect(onChange).toHaveBeenCalledWith([
      { kind: 'field', key: 'org', op: '$eq', value: 'extern' },
    ]);
  });
});
