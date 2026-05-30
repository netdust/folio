import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunStatusChip } from './run-status-chip.tsx';

describe('RunStatusChip', () => {
  test('renders a humanized label for each of the 6 run statuses', () => {
    const cases: [string, string][] = [
      ['planning', 'planning'], ['running', 'running'],
      ['awaiting_approval', 'awaiting approval'], ['completed', 'completed'],
      ['failed', 'failed'], ['rejected', 'rejected'],
    ];
    for (const [status, label] of cases) {
      const { unmount } = render(<RunStatusChip status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });
  test('completed and failed render with different tone classes', () => {
    const { container: ok } = render(<RunStatusChip status="completed" />);
    const { container: bad } = render(<RunStatusChip status="failed" />);
    expect((ok.firstChild as HTMLElement).className).not.toBe((bad.firstChild as HTMLElement).className);
  });
  test('unknown status falls back to a neutral badge with the raw label', () => {
    render(<RunStatusChip status="weird" />);
    expect(screen.getByText('weird')).toBeInTheDocument();
  });
});
