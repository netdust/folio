import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Folder } from 'lucide-react';
import { RailTree } from './rail-tree.tsx';

describe('RailTree', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders a flat item as a single row', () => {
    render(<RailTree items={[{ id: 'a', label: 'Hello' }]} />);

    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('clicking the label navigates (item.onClick) without toggling expansion', async () => {
    const onParentClick = vi.fn();
    render(
      <RailTree
        items={[
          {
            id: 'parent',
            label: 'Parent',
            onClick: onParentClick,
            children: [{ id: 'child', label: 'Child' }],
          },
        ]}
      />,
    );

    // Top-level (depth=0) defaults to expanded — child visible.
    expect(screen.getByText('Child')).toBeInTheDocument();

    const parentLabel = screen
      .getAllByTestId('rail-tree-item')
      .find((el) => el.textContent === 'Parent');
    expect(parentLabel).toBeDefined();

    await userEvent.click(parentLabel!);

    // Label click invokes onClick (navigates), keeps the tree expanded.
    expect(onParentClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Child')).toBeInTheDocument();
    expect(localStorage.getItem('folio:rail-expanded:parent')).not.toBe('0');
  });

  it('clicking the chevron toggles expansion without firing item.onClick', async () => {
    const onParentClick = vi.fn();
    render(
      <RailTree
        items={[
          {
            id: 'parent',
            label: 'Parent',
            onClick: onParentClick,
            children: [{ id: 'child', label: 'Child' }],
          },
        ]}
      />,
    );

    expect(screen.getByText('Child')).toBeInTheDocument();

    const chevron = screen.getByTestId('rail-tree-chevron-parent');
    await userEvent.click(chevron);

    // Chevron click collapses children, must NOT navigate.
    expect(screen.queryByText('Child')).not.toBeInTheDocument();
    expect(onParentClick).not.toHaveBeenCalled();
    expect(localStorage.getItem('folio:rail-expanded:parent')).toBe('0');

    await userEvent.click(chevron);
    expect(screen.getByText('Child')).toBeInTheDocument();
    expect(localStorage.getItem('folio:rail-expanded:parent')).toBe('1');
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('expandable row with an icon: icon shows by default, chevron hidden until hover (same slot)', () => {
    render(
      <RailTree
        items={[
          {
            id: 'parent',
            label: 'Parent',
            lucideIcon: Folder,
            children: [{ id: 'child', label: 'Child' }],
          },
        ]}
      />,
    );

    // The chevron button is the slot. Inside it, the icon renders without `hidden`
    // by default and the chevron carries `hidden group-hover/row:inline-block`.
    const slot = screen.getByTestId('rail-tree-chevron-parent');
    const icon = slot.querySelector('svg.lucide-folder');
    const chevron = slot.querySelector('svg.lucide-chevron-right');
    expect(icon).toBeTruthy();
    expect(chevron).toBeTruthy();
    const iconClass = icon!.getAttribute('class') ?? '';
    const chevronClass = chevron!.getAttribute('class') ?? '';
    expect(iconClass).toContain('group-hover/row:hidden');
    expect(chevronClass).toContain('hidden');
    expect(chevronClass).toContain('group-hover/row:inline-block');
  });

  it('non-expandable row with an icon: icon visible, no chevron testid', () => {
    render(<RailTree items={[{ id: 'leaf', label: 'Leaf', lucideIcon: Folder }]} />);

    expect(screen.queryByTestId('rail-tree-chevron-leaf')).toBeNull();
    // The icon still renders.
    expect(document.querySelector('svg.lucide-folder')).toBeTruthy();
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
