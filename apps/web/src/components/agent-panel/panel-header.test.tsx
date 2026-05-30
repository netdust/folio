import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelHeader, type PanelTab } from './panel-header.tsx';

type Screen = 'activity' | 'run' | 'agents';

const tabs: PanelTab<Screen>[] = [
  { value: 'activity', icon: 'A', label: 'Activity' },
  { value: 'run', icon: 'R', label: 'Run' },
  { value: 'agents', icon: 'G', label: 'Agents' },
];

describe('PanelHeader', () => {
  test('renders the title', () => {
    render(
      <PanelHeader title="Agents" tabs={tabs} active="activity" onTab={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  test('renders a button per tab (found by aria-label)', () => {
    render(
      <PanelHeader title="Agents" tabs={tabs} active="activity" onTab={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByLabelText('Activity')).toBeInTheDocument();
    expect(screen.getByLabelText('Run')).toBeInTheDocument();
    expect(screen.getByLabelText('Agents')).toBeInTheDocument();
  });

  test('clicking a tab fires onTab(value)', async () => {
    const user = userEvent.setup();
    const onTab = vi.fn();
    render(
      <PanelHeader title="Agents" tabs={tabs} active="activity" onTab={onTab} onClose={() => {}} />,
    );
    await user.click(screen.getByLabelText('Run'));
    expect(onTab).toHaveBeenCalledWith('run');
  });

  test('clicking close fires onClose()', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PanelHeader title="Agents" tabs={tabs} active="activity" onTab={() => {}} onClose={onClose} />,
    );
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('the active tab has aria-pressed="true"', () => {
    render(
      <PanelHeader title="Agents" tabs={tabs} active="run" onTab={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByLabelText('Run')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Activity')).toHaveAttribute('aria-pressed', 'false');
  });
});
