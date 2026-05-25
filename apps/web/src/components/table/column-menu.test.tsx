import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ColumnMenu } from './column-menu.tsx';

describe('ColumnMenu', () => {
  it('renders Rename, Hide, Delete actions', () => {
    render(
      <ColumnMenu
        columnKey="priority"
        columnLabel="Priority"
        onRename={() => {}}
        onChangeType={() => {}}
        onHide={() => {}}
        onDelete={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /hide column/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete column/i })).toBeInTheDocument();
  });

  it('calls onRename when Rename is selected', () => {
    const onRename = vi.fn();
    render(
      <ColumnMenu
        columnKey="priority"
        columnLabel="Priority"
        onRename={onRename}
        onChangeType={() => {}}
        onHide={() => {}}
        onDelete={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }));
    expect(onRename).toHaveBeenCalled();
  });

  it('calls onChangeType when Change type is selected', () => {
    const onChangeType = vi.fn();
    render(
      <ColumnMenu
        columnKey="priority"
        columnLabel="Priority"
        onRename={() => {}}
        onChangeType={onChangeType}
        onHide={() => {}}
        onDelete={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /change type/i }));
    expect(onChangeType).toHaveBeenCalled();
  });

  it('shows confirm dialog before deleting and calls onDelete only after confirm', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <ColumnMenu
        columnKey="priority"
        columnLabel="Priority"
        onRename={() => {}}
        onChangeType={() => {}}
        onHide={() => {}}
        onDelete={onDelete}
        affectedDocCount={3}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /column actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete column/i }));

    expect(await screen.findByText(/delete column .priority./i)).toBeInTheDocument();
    expect(screen.getByText(/3 document/i)).toBeInTheDocument();

    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(onDelete).toHaveBeenCalled();
  });
});
