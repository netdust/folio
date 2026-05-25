import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ColumnTypeChange } from './column-type-change.tsx';

describe('ColumnTypeChange', () => {
  it('lists the current type and offers compatible targets', () => {
    render(<ColumnTypeChange currentType="string" currentOptions={null} onSubmit={vi.fn()} onClose={vi.fn()} open />);
    expect(screen.getByLabelText(/^new type$/i)).toBeInTheDocument();
    const select = screen.getByLabelText(/^new type$/i) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    // string → text is compatible; string → text → string round-trip listed
    expect(options).toContain('text');
    // string → select is incompatible — not in the dropdown (or disabled)
    expect(options).not.toContain('select');
  });

  it('shows ISO input when target is currency and source is number', () => {
    render(<ColumnTypeChange currentType="number" currentOptions={null} onSubmit={vi.fn()} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'currency' } });
    expect(screen.getByLabelText(/iso code/i)).toBeInTheDocument();
    expect((screen.getByLabelText(/iso code/i) as HTMLInputElement).value).toBe('EUR');
  });

  it('calls onSubmit with the new type + options on Apply', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ColumnTypeChange currentType="number" currentOptions={null} onSubmit={onSubmit} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'currency' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ type: 'currency', options: ['EUR'] });
    });
  });

  it('does not include options for changes that drop the array (currency → number)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ColumnTypeChange currentType="currency" currentOptions={['EUR']} onSubmit={onSubmit} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'number' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ type: 'number', options: null });
    });
  });

  it('surfaces an error returned from onSubmit', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('server said no'));
    render(<ColumnTypeChange currentType="string" currentOptions={null} onSubmit={onSubmit} onClose={vi.fn()} open />);
    fireEvent.change(screen.getByLabelText(/^new type$/i), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    expect(await screen.findByText(/server said no/i)).toBeInTheDocument();
  });
});
