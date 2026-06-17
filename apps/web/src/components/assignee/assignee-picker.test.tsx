import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssigneePicker } from './assignee-picker.tsx';
import {
  agentsResponse,
  memberResponse,
  projectsResponse,
  stubFetch,
  wrap,
} from './test-fixtures.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AssigneePicker', () => {
  it('renders sections for Members and Agents and lists each', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse, // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    render(<AssigneePicker wslug="acme" pslug="web" value="" onChange={() => {}} />, {
      wrapper: wrap(qc),
    });
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));

    expect(await screen.findByText(/members/i)).toBeInTheDocument();
    expect(screen.getByText(/agents/i)).toBeInTheDocument();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(await screen.findByText('Triage Bot')).toBeInTheDocument();
  });

  it('clicking a member calls onChange with the email', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse, // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    const onChange = vi.fn();
    render(<AssigneePicker wslug="acme" pslug="web" value="" onChange={onChange} />, {
      wrapper: wrap(qc),
    });
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Alice alice@test/i }));
    expect(onChange).toHaveBeenCalledWith('alice@test');
  });

  it('clicking an agent calls onChange with agent:<slug>', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse, // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    const onChange = vi.fn();
    render(<AssigneePicker wslug="acme" pslug="web" value="" onChange={onChange} />, {
      wrapper: wrap(qc),
    });
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Triage Bot/i }));
    expect(onChange).toHaveBeenCalledWith('agent:triage-bot');
  });

  it('shows the current value in the trigger label', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse, // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    render(
      <AssigneePicker wslug="acme" pslug="web" value="agent:triage-bot" onChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    // Wait for agents to load so the label resolves to the friendly name.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /triage bot/i })).toBeInTheDocument();
    });
  });

  it('Unassign option clears the value to empty string', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse, // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    const onChange = vi.fn();
    render(<AssigneePicker wslug="acme" pslug="web" value="alice@test" onChange={onChange} />, {
      wrapper: wrap(qc),
    });
    await userEvent.click(screen.getByRole('button', { name: /alice/i }));
    await userEvent.click(await screen.findByRole('button', { name: /clear assignee|unassign/i }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('typing in the search box narrows the member list (seam over the real filter)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse,
      '/projects': projectsResponse,
      '/members': memberResponse,
    });
    render(<AssigneePicker wslug="acme" pslug="web" value="" onChange={() => {}} />, {
      wrapper: wrap(qc),
    });
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));
    // Both members visible with an empty query.
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // Filtering to "ali" keeps Alice, drops Bob.
    await userEvent.type(screen.getByLabelText(/filter assignees/i), 'ali');
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });
});
