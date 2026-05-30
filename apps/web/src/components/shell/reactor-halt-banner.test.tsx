import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub the E-2b hook — these tests verify banner rendering, not SSE plumbing.
const useReactorHealthMock = vi.fn();
vi.mock('../../lib/api/provider-health.ts', () => ({
  useReactorHealth: (wslug: string) => useReactorHealthMock(wslug),
}));

import { ReactorHaltBanner } from './reactor-halt-banner.tsx';

beforeEach(() => {
  useReactorHealthMock.mockReset();
});

describe('ReactorHaltBanner', () => {
  test('renders nothing when the reactor is not halted', () => {
    useReactorHealthMock.mockReturnValue({ halted: false, errorClass: null });
    const { container } = render(<ReactorHaltBanner wslug="acme" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows the paused notice and the error class when halted', () => {
    useReactorHealthMock.mockReturnValue({ halted: true, errorClass: 'TypeError' });
    render(<ReactorHaltBanner wslug="acme" />);
    expect(screen.getByText(/automation paused/i)).toBeInTheDocument();
    expect(screen.getByText(/TypeError/)).toBeInTheDocument();
  });
});
