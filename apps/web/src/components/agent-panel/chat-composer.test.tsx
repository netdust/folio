import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatComposer } from './chat-composer.tsx';

describe('ChatComposer', () => {
  const onSubmit = vi.fn();
  beforeEach(() => onSubmit.mockReset());

  test('submits the trimmed text on Enter and clears the field', async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSubmit={onSubmit} busy={false} />);
    const box = screen.getByRole('textbox');
    await user.type(box, '  hello operator  ');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello operator');
    expect(box).toHaveValue('');
  });

  test('Shift+Enter inserts a newline and does NOT submit', async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSubmit={onSubmit} busy={false} />);
    const box = screen.getByRole('textbox');
    await user.type(box, 'line1');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(box, 'line2');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box).toHaveValue('line1\nline2');
  });

  test('does not submit empty / whitespace-only input', async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSubmit={onSubmit} busy={false} />);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('   {Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('while busy: disabled, shows "operator is working…", blocks submit', async () => {
    const user = userEvent.setup();
    render(<ChatComposer onSubmit={onSubmit} busy={true} />);
    const box = screen.getByRole('textbox');
    expect(box).toBeDisabled();
    expect(screen.getByText(/operator is working/i)).toBeInTheDocument();
    // Even if a value were present, Enter must not fire onSubmit while busy.
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
