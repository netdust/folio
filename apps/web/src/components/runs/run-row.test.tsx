import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunRow } from './run-row.tsx';

const run = {
  id: 'r1', slug: 'run-1', type: 'agent_run' as const, title: 'run', status: 'running',
  frontmatter: { agent_slug: 'reply-bot', fired_by: 'assignment', error_reason: null },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), parentId: 'p1', lastTouchedAt: null,
};

describe('RunRow', () => {
  test('renders agent, status, fired-by', () => {
    render(<RunRow run={run as never} docTitle="Lead #482" />);
    expect(screen.getByText('reply-bot')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText(/assignment/)).toBeInTheDocument();
  });
  test('renders the doc title when provided', () => {
    render(<RunRow run={run as never} docTitle="Lead #482" />);
    expect(screen.getByText(/Lead #482/)).toBeInTheDocument();
  });
  test('clicking fires onClick when interactive', () => {
    const onClick = vi.fn();
    render(<RunRow run={run as never} docTitle="Lead #482" onClick={onClick} />);
    fireEvent.click(screen.getByText('reply-bot').closest('[role="button"]')!);
    expect(onClick).toHaveBeenCalled();
  });
  test('no onClick → not a button', () => {
    render(<RunRow run={run as never} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
