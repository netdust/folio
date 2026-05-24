import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineSelect } from './inline-select.tsx';

const OPTIONS = [
  { value: 'todo', label: 'Todo' },
  { value: 'doing', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

describe('InlineSelect', () => {
  it('renders display label matching the current value', () => {
    render(<InlineSelect value="todo" options={OPTIONS} onCommit={() => {}} />);
    expect(screen.getByText('Todo')).toBeInTheDocument();
  });

  it('clicking opens popover and choosing an option fires onCommit', async () => {
    const onCommit = vi.fn();
    render(<InlineSelect value="todo" options={OPTIONS} onCommit={onCommit} />);
    await userEvent.click(screen.getByText('Todo'));
    const doneItem = await screen.findByRole('option', { name: 'Done' });
    await userEvent.click(doneItem);
    expect(onCommit).toHaveBeenCalledWith('done');
  });

  it('selecting the current value does not fire onCommit', async () => {
    const onCommit = vi.fn();
    render(<InlineSelect value="todo" options={OPTIONS} onCommit={onCommit} />);
    await userEvent.click(screen.getByText('Todo'));
    const todoItem = await screen.findByRole('option', { name: 'Todo' });
    await userEvent.click(todoItem);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows fallback when value matches no option', () => {
    render(
      <InlineSelect
        value="mystery"
        options={OPTIONS}
        onCommit={() => {}}
        placeholder="Set status"
      />,
    );
    expect(screen.getByText('Set status')).toBeInTheDocument();
  });
});
