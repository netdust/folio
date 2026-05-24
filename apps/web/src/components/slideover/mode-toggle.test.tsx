import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeToggle } from './mode-toggle.tsx';

describe('ModeToggle', () => {
  it('renders Edit + Raw MD buttons; highlights active mode', () => {
    render(<ModeToggle mode="rich" onChange={() => {}} />);
    const edit = screen.getByRole('button', { name: /^Edit$/ });
    const raw = screen.getByRole('button', { name: /Raw MD/ });
    expect(edit.className).toMatch(/bg-primary/);
    expect(raw.className).not.toMatch(/bg-primary/);
  });

  it('clicking the inactive button calls onChange with the new mode', async () => {
    const onChange = vi.fn();
    render(<ModeToggle mode="rich" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Raw MD/ }));
    expect(onChange).toHaveBeenCalledWith('raw');
  });

  it('clicking the active button does not fire onChange', async () => {
    const onChange = vi.fn();
    render(<ModeToggle mode="rich" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
