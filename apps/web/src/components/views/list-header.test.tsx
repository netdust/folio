import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListHeader } from './list-header.tsx';

describe('ListHeader', () => {
  it('clicking inactive column sorts ascending', async () => {
    const onSort = vi.fn();
    render(<ListHeader sort={null} onSort={onSort} />);
    await userEvent.click(screen.getByRole('button', { name: /Title/i }));
    expect(onSort).toHaveBeenCalledWith({ key: 'title', dir: 'asc' });
  });

  it('clicking ascending column flips to descending', async () => {
    const onSort = vi.fn();
    render(<ListHeader sort={{ key: 'title', dir: 'asc' }} onSort={onSort} />);
    await userEvent.click(screen.getByRole('button', { name: /Title/i }));
    expect(onSort).toHaveBeenCalledWith({ key: 'title', dir: 'desc' });
  });

  it('clicking descending column clears sort', async () => {
    const onSort = vi.fn();
    render(<ListHeader sort={{ key: 'title', dir: 'desc' }} onSort={onSort} />);
    await userEvent.click(screen.getByRole('button', { name: /Title/i }));
    expect(onSort).toHaveBeenCalledWith(null);
  });

  it('shows arrow indicator on the active column', () => {
    render(<ListHeader sort={{ key: 'updated_at', dir: 'desc' }} onSort={() => {}} />);
    expect(screen.getByText('↓')).toBeInTheDocument();
  });
});
