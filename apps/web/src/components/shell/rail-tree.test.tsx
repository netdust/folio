import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RailTree } from './rail-tree.tsx';

describe('RailTree', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders a flat item without a chevron', () => {
    render(<RailTree items={[{ id: 'a', label: 'Hello' }]} />);

    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.queryByTestId('rail-tree-chevron')).not.toBeInTheDocument();
  });

  it('toggles expansion on chevron click and persists state to localStorage', async () => {
    render(
      <RailTree
        items={[
          {
            id: 'parent',
            label: 'Parent',
            children: [{ id: 'child', label: 'Child' }],
          },
        ]}
      />,
    );

    // Top-level (depth=0) defaults to expanded — child visible.
    expect(screen.getByText('Child')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('rail-tree-chevron'));
    expect(screen.queryByText('Child')).not.toBeInTheDocument();
    expect(localStorage.getItem('folio:rail-expanded:parent')).toBe('0');

    await userEvent.click(screen.getByTestId('rail-tree-chevron'));
    expect(screen.getByText('Child')).toBeInTheDocument();
    expect(localStorage.getItem('folio:rail-expanded:parent')).toBe('1');
  });

  it('clicking a child invokes its onClick', async () => {
    const onLeafClick = vi.fn();
    render(
      <RailTree
        items={[
          {
            id: 'parent',
            label: 'Parent',
            children: [{ id: 'leaf', label: 'Leaf', onClick: onLeafClick }],
          },
        ]}
      />,
    );

    const leaf = screen
      .getAllByTestId('rail-tree-item')
      .find((el) => el.textContent === 'Leaf');
    expect(leaf).toBeDefined();
    await userEvent.click(leaf!);
    expect(onLeafClick).toHaveBeenCalledTimes(1);
  });
});
