import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineEdit } from './inline-edit.tsx';

describe('InlineEdit', () => {
  it('renders display mode initially', () => {
    render(<InlineEdit value="Hello" onCommit={() => {}} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('clicking enters edit mode with text pre-selected and autofocused', async () => {
    render(<InlineEdit value="Hello" onCommit={() => {}} />);
    await userEvent.click(screen.getByText('Hello'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });

  it('Enter commits and returns to display', async () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="Hello" onCommit={onCommit} />);
    await userEvent.click(screen.getByText('Hello'));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'World{Enter}');
    expect(onCommit).toHaveBeenCalledWith('World');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('Escape reverts to original and returns to display', async () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="Hello" onCommit={onCommit} />);
    await userEvent.click(screen.getByText('Hello'));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'World{Escape}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('blur commits the current draft', async () => {
    const onCommit = vi.fn();
    render(
      <>
        <InlineEdit value="Hello" onCommit={onCommit} />
        <button type="button">elsewhere</button>
      </>,
    );
    await userEvent.click(screen.getByText('Hello'));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'World');
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(onCommit).toHaveBeenCalledWith('World');
  });

  it('does not call onCommit if value unchanged', async () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="Hello" onCommit={onCommit} />);
    await userEvent.click(screen.getByText('Hello'));
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows pending state when isPending prop true', () => {
    render(<InlineEdit value="Hello" onCommit={() => {}} isPending />);
    expect(screen.getByText('Hello').className).toMatch(/opacity/);
  });

  it('defaultEditing treats value as placeholder so typing replaces, not appends', async () => {
    const onCommit = vi.fn();
    render(<InlineEdit value="Untitled" onCommit={onCommit} defaultEditing />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Untitled');
    await userEvent.type(input, 'My first task{Enter}');
    expect(onCommit).toHaveBeenCalledWith('My first task');
  });

  it('defaultEditing: blurring with empty draft reverts instead of committing empty', async () => {
    const onCommit = vi.fn();
    render(
      <>
        <InlineEdit value="Untitled" onCommit={onCommit} defaultEditing />
        <button type="button">elsewhere</button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText('Untitled')).toBeInTheDocument();
  });
});
