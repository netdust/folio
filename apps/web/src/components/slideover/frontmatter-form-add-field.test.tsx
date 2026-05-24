import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FrontmatterForm } from './frontmatter-form.tsx';

describe('FrontmatterForm + Add field', () => {
  afterEach(() => vi.restoreAllMocks());

  it('typing a new field name and submitting calls onFrontmatterCommit with key: ""', async () => {
    const onCommit = vi.fn();
    render(
      <FrontmatterForm
        type="work_item"
        status={null}
        statuses={[]}
        frontmatter={{ priority: 'low' }}
        pinnedFields={[]}
        onStatusCommit={() => {}}
        onFrontmatterCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Add field/i }));
    const input = await screen.findByPlaceholderText(/Field name/i);
    await userEvent.type(input, 'due_date{Enter}');

    expect(onCommit).toHaveBeenCalledWith({ due_date: '' });
  });

  it('typing an existing field name shows an inline error and does NOT fire commit', async () => {
    const onCommit = vi.fn();
    render(
      <FrontmatterForm
        type="work_item"
        status={null}
        statuses={[]}
        frontmatter={{ priority: 'low' }}
        pinnedFields={[]}
        onStatusCommit={() => {}}
        onFrontmatterCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Add field/i }));
    const input = await screen.findByPlaceholderText(/Field name/i);
    await userEvent.type(input, 'priority{Enter}');

    expect(screen.getByText(/Field already exists/i)).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
