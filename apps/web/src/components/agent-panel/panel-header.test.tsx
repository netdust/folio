import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelHeader } from './panel-header.tsx';

const tabs = [
  { value: 'run', icon: '▶', label: 'Run' },
  { value: 'activity', icon: '⚡', label: 'Activity' },
];

describe('PanelHeader', () => {
  test('renders title + a button per tab + close', () => {
    render(<PanelHeader title="Agents" tabs={tabs as never} active="run" onTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activity/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });
  test('clicking a tab fires onTab(value)', () => {
    const onTab = vi.fn();
    render(<PanelHeader title="Agents" tabs={tabs as never} active="run" onTab={onTab} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /activity/i }));
    expect(onTab).toHaveBeenCalledWith('activity');
  });
  test('clicking close fires onClose', () => {
    const onClose = vi.fn();
    render(<PanelHeader title="Agents" tabs={tabs as never} active="run" onTab={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
