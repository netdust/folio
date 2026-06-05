import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub the router so the banner's Link renders as a plain anchor without a
// RouterProvider. We capture the navigation target via the Link's `to`/`search`
// props rendered onto the anchor.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// Stub the E-2b hook — these tests verify banner rendering, not the query/SSE
// plumbing (covered in provider-health.test).
const useProviderHealthMock = vi.fn();
vi.mock('../../lib/api/provider-health.ts', () => ({
  useProviderHealth: (wslug: string) => useProviderHealthMock(wslug),
}));

import { ProviderHealthBanner } from './provider-health-banner.tsx';

const HEALTHY = { status: 'healthy' as const, consecutiveFailures: 0 };
const DEGRADED = { status: 'degraded' as const, consecutiveFailures: 3 };

beforeEach(() => {
  navigateMock.mockReset();
  useProviderHealthMock.mockReset();
});

describe('ProviderHealthBanner', () => {
  test('renders nothing when all providers are healthy', () => {
    useProviderHealthMock.mockReturnValue({
      data: {
        anthropic: HEALTHY,
        openai: HEALTHY,
        openrouter: HEALTHY,
        ollama: HEALTHY,
      },
    });
    const { container } = render(<ProviderHealthBanner wslug="acme" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders nothing while the query has no data', () => {
    useProviderHealthMock.mockReturnValue({ data: undefined });
    const { container } = render(<ProviderHealthBanner wslug="acme" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('names the degraded provider and offers a Check key action', async () => {
    useProviderHealthMock.mockReturnValue({
      data: {
        anthropic: DEGRADED,
        openai: HEALTHY,
        openrouter: HEALTHY,
        ollama: HEALTHY,
      },
    });
    render(<ProviderHealthBanner wslug="acme" />);

    expect(screen.getByText(/anthropic/i)).toBeInTheDocument();

    const link = screen.getByRole('button', { name: /check key/i });
    link.click();
    // AI keys moved to the instance settings page (instance-wide store).
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/settings',
        search: { tab: 'ai', provider: 'anthropic' },
      }),
    );
  });
});
