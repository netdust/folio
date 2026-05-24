import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from './tabs.tsx';

const ITEMS = [
  { value: 'a' as const, label: 'A' },
  { value: 'b' as const, label: 'B' },
  { value: 'c' as const, label: 'C' },
];

describe('Tabs', () => {
  it('renders all items', () => {
    render(<Tabs value="a" onChange={() => {}} items={ITEMS} />);
    expect(screen.getByRole('button', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'C' })).toBeInTheDocument();
  });

  it('clicking inactive item fires onChange with new value', async () => {
    const onChange = vi.fn();
    render(<Tabs value="a" onChange={onChange} items={ITEMS} />);
    await userEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('clicking active item does not fire onChange', async () => {
    const onChange = vi.fn();
    render(<Tabs value="a" onChange={onChange} items={ITEMS} />);
    await userEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
