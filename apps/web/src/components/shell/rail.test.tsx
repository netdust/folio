import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderOpen, Search, Home, Table2 } from 'lucide-react';
import { Rail } from './rail.tsx';
import { subscribeOpenEvent, openCommandPalette } from '../../lib/command-palette-bus.ts';

describe('Rail', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the lucide icon for a nav item with lucideIcon set', () => {
    const { container } = render(
      <Rail
        brand={{ mark: 'F', label: 'Folio' }}
        workspace={{ mark: 'B', name: 'BAVI' }}
        primary={[{ id: 'a', label: 'Web', lucideIcon: Home }]}
        user={{ name: 'Stefan' }}
      />,
    );
    expect(screen.getByText('Web')).toBeInTheDocument();
    const svgs = container.querySelectorAll('svg[stroke-width="1.5"]');
    expect(svgs.length).toBeGreaterThan(0);
  });

  it('collapsed rail: clicking a project icon opens a popover listing its children', async () => {
    // Pre-seed the rail to collapsed so we exercise the collapsed NavList branch.
    localStorage.setItem('folio:rail-collapsed', '1');

    const onChildClick = vi.fn();
    render(
      <Rail
        brand={{ mark: 'F', label: 'Folio' }}
        workspace={{ mark: 'B', name: 'BAVI' }}
        primary={[{
          id: 'project:sales',
          label: 'Sales',
          lucideIcon: FolderOpen,
          children: [
            { id: 'table:work-items', label: 'Work Items', lucideIcon: Table2, onClick: onChildClick },
          ],
        }]}
        user={{ name: 'Stefan' }}
      />,
    );

    // Project icon button is visible (aria-label === item.label).
    const projectBtn = screen.getByRole('button', { name: 'Sales' });
    await userEvent.click(projectBtn);

    // The popover surfaces the child rows.
    const childBtn = await screen.findByRole('button', { name: /Work Items/i });
    await userEvent.click(childBtn);
    expect(onChildClick).toHaveBeenCalled();
  });

  it('clicking the Search nav item dispatches the command-palette bus event', async () => {
    const heard = vi.fn();
    const unsub = subscribeOpenEvent(heard);
    try {
      render(
        <Rail
          brand={{ mark: 'F', label: 'Folio' }}
          workspace={{ mark: 'B', name: 'BAVI' }}
          primary={[]}
          tools={[{ id: 'search', label: 'Search', lucideIcon: Search, kbd: '⌘K', onClick: openCommandPalette }]}
          user={{ name: 'Stefan' }}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /Search/i }));
      expect(heard).toHaveBeenCalled();
    } finally {
      unsub();
    }
  });
});
