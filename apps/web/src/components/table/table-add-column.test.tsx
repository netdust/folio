import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TableAddColumn } from './table-add-column.tsx';

describe('TableAddColumn', () => {
  it('opens a popover and submits a valid string field', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TableAddColumn onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText(/^label$/i), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: 'string' } });

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ key: 'owner', label: 'Owner', type: 'string' });
    });
  });

  it('disables Create until a key is entered', () => {
    render(<TableAddColumn onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    const createBtn = screen.getByRole('button', { name: /^create$/i });
    expect(createBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'owner' } });
    expect(createBtn).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: '' } });
    expect(createBtn).toBeDisabled();
  });

  it('rejects invalid keys (uppercase, leading number, special chars)', async () => {
    const onSubmit = vi.fn();
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'Owner Name' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/lowercase letters, numbers, underscore/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires options for select and multi_select types', async () => {
    const onSubmit = vi.fn();
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'priority' } });
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: 'select' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/at least one option/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires a 3-letter ISO code for currency', async () => {
    const onSubmit = vi.fn();
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'price' } });
    fireEvent.change(screen.getByLabelText(/^type$/i), { target: { value: 'currency' } });
    // currency input defaults to EUR; clear it and submit empty
    fireEvent.change(screen.getByLabelText(/iso code/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/3-letter iso-4217/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('auto-derives the label from the key when label is left blank', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TableAddColumn onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /add column/i }));

    fireEvent.change(screen.getByLabelText(/^key$/i), { target: { value: 'next_action' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'next_action', label: 'Next Action', type: 'string' }),
      );
    });
  });
});
