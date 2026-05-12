import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Search, Home } from 'lucide-react';
import { Rail } from './rail.tsx';
import { subscribeOpenEvent, openCommandPalette } from '../../lib/command-palette-bus.ts';

describe('Rail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the lucide icon for a nav item with lucideIcon set', () => {
    const { container } = render(
      <Rail
        brand={{ mark: 'F', label: 'Folio' }}
        workspace={{ mark: 'B', name: 'BAVI' }}
        primary={[{ id: 'a', label: 'Web', lucideIcon: Home, icon: null }]}
        user={{ name: 'Stefan' }}
      />,
    );
    expect(screen.getByText('Web')).toBeInTheDocument();
    // Lucide icons render as <svg>; the Icon wrapper sets stroke-width=1.5
    const svgs = container.querySelectorAll('svg[stroke-width="1.5"]');
    expect(svgs.length).toBeGreaterThan(0);
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
          tools={[{ id: 'search', label: 'Search', lucideIcon: Search, kbd: '⌘K', icon: null, onClick: openCommandPalette }]}
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
