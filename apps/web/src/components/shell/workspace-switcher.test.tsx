import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceSwitcher } from './workspace-switcher.tsx';

const baseProps = {
  trigger: <button type="button">open</button>,
  workspaces: [{ id: 'w1', slug: 'ws', name: 'WS', mark: 'W' }],
  onSelectWorkspace: vi.fn(),
};

describe('WorkspaceSwitcher — Agents entry + create footer', () => {
  it('omits Agents when its handler is not provided', () => {
    render(<WorkspaceSwitcher {...baseProps} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.queryByText('Agents & Triggers')).not.toBeInTheDocument();
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

  it('has NO standalone Triggers entry — triggers live as a tab on the agents page', () => {
    render(<WorkspaceSwitcher {...baseProps} onOpenAgents={vi.fn()} />);
    fireEvent.click(screen.getByText('open'));
    // "Agents & Triggers" is the only entry naming triggers; there is no bare
    // "Triggers" button (the duplicate route surface was removed).
    expect(
      screen.queryByRole('button', { name: /^triggers$/i }),
    ).not.toBeInTheDocument();
  });

  it('has NO Workspace settings entry — it lives in the user menu', () => {
    render(
      <WorkspaceSwitcher
        {...baseProps}
        onCreateProject={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    expect(screen.queryByText('Workspace settings')).not.toBeInTheDocument();
  });

  it('footer = New project then Create workspace, with Agents above it', () => {
    render(
      <WorkspaceSwitcher
        {...baseProps}
        onOpenAgents={vi.fn()}
        onCreateProject={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    const labels = screen
      .getAllByRole('button')
      .map((el) => (el.textContent ?? '').trim())
      .filter((text) =>
        ['Agents & Triggers', '+ New project', '+ Create workspace'].includes(text),
      );
    expect(labels).toEqual([
      'Agents & Triggers',
      '+ New project',
      '+ Create workspace',
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
