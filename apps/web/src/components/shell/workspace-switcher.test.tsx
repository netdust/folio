import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceSwitcher } from './workspace-switcher.tsx';

const baseProps = {
  trigger: <button type="button">open</button>,
  workspaces: [{ id: 'w1', slug: 'ws', name: 'WS', mark: 'W' }],
  onSelectWorkspace: vi.fn(),
};

describe('WorkspaceSwitcher — Phase 2.5 Agents + Triggers entries', () => {
  it('omits Agents + Triggers when handlers are not provided', () => {
    render(<WorkspaceSwitcher {...baseProps} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.queryByText('Agents & Triggers')).not.toBeInTheDocument();
    expect(screen.queryByText('Triggers')).not.toBeInTheDocument();
    expect(screen.queryByText('Work with an agent')).not.toBeInTheDocument();
  });

  it('renders Agents & Triggers entry when onOpenAgents is provided; click fires the handler', () => {
    const onOpenAgents = vi.fn();
    render(<WorkspaceSwitcher {...baseProps} onOpenAgents={onOpenAgents} />);
    fireEvent.click(screen.getByText('open'));
    const agents = screen.getByText('Agents & Triggers');
    expect(agents).toBeInTheDocument();
    fireEvent.click(agents);
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it('renders Triggers entry when onOpenTriggers is provided; click fires the handler', () => {
    const onOpenTriggers = vi.fn();
    render(<WorkspaceSwitcher {...baseProps} onOpenTriggers={onOpenTriggers} />);
    fireEvent.click(screen.getByText('open'));
    const triggers = screen.getByText('Triggers');
    expect(triggers).toBeInTheDocument();
    fireEvent.click(triggers);
    expect(onOpenTriggers).toHaveBeenCalledTimes(1);
  });

  it('renders Agents + Triggers above the existing footer when both are provided', () => {
    render(
      <WorkspaceSwitcher
        {...baseProps}
        onOpenAgents={vi.fn()}
        onOpenTriggers={vi.fn()}
        onCreateProject={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    const labels = screen
      .getAllByRole('button')
      .map((el) => (el.textContent ?? '').trim())
      .filter((text) =>
        [
          'Agents & Triggers',
          'Triggers',
          '+ New project',
          '+ Create workspace',
          'Workspace settings',
        ].includes(text),
      );
    expect(labels).toEqual([
      'Agents & Triggers',
      'Triggers',
      '+ New project',
      '+ Create workspace',
      'Workspace settings',
    ]);
  });

  it('routes management to the page and interaction to the panel', async () => {
    const onOpenAgents = vi.fn();
    const onWorkWithAgent = vi.fn();
    render(
      <WorkspaceSwitcher
        {...baseProps}
        onOpenAgents={onOpenAgents}
        onWorkWithAgent={onWorkWithAgent}
      />,
    );
    await userEvent.click(screen.getByText('open'));
    await userEvent.click(screen.getByRole('button', { name: /agents & triggers/i }));
    expect(onOpenAgents).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /work with an agent/i }));
    expect(onWorkWithAgent).toHaveBeenCalled();
  });
});
