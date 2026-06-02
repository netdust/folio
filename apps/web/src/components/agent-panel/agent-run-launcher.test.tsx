import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentRunLauncher } from './agent-run-launcher.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST' && u.endsWith('/runs')) {
      return new Response(JSON.stringify({ data: { run_id: 'r9', status: 'planning' } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    // workspace agents list
    return new Response(JSON.stringify({ data: [{ id: 'a1', slug: 'bot', type: 'agent', title: 'Reply Bot', frontmatter: {}, status: null, parentId: null, createdAt: '', updatedAt: '', lastTouchedAt: null }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('AgentRunLauncher', () => {
  test('submitting agent + parent fires create run + onLaunched(result)', async () => {
    const onLaunched = vi.fn();
    wrap(<AgentRunLauncher wslug="acme" onLaunched={onLaunched} />);
    // wait for agents to load into the select
    await screen.findByRole('option', { name: /Reply Bot/i });
    fireEvent.change(screen.getByLabelText(/agent/i), { target: { value: 'bot' } });
    fireEvent.change(screen.getByLabelText(/parent|target/i), { target: { value: 'task-1' } });
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'r9' })));
    const postCall = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toMatchObject({ agent_slug: 'bot', parent_slug: 'task-1' });
  });

  test('surfaces server error and does not call onLaunched on failure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST' && u.endsWith('/runs')) {
        return new Response(
          JSON.stringify({ error: { code: 'RUN_ALREADY_ACTIVE', message: 'A run is already active.' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: 'a1', slug: 'bot', type: 'agent', title: 'Reply Bot', frontmatter: {}, status: null, parentId: null, createdAt: '', updatedAt: '', lastTouchedAt: null }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const onLaunched = vi.fn();
    wrap(<AgentRunLauncher wslug="acme" onLaunched={onLaunched} />);
    await screen.findByRole('option', { name: /Reply Bot/i });
    fireEvent.change(screen.getByLabelText(/agent/i), { target: { value: 'bot' } });
    fireEvent.change(screen.getByLabelText(/parent|target/i), { target: { value: 'task-1' } });
    fireEvent.click(screen.getByRole('button', { name: /run agent/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A run is already active.');
    expect(onLaunched).not.toHaveBeenCalled();
  });

  test('disables submit until agent + parent are chosen', () => {
    wrap(<AgentRunLauncher wslug="acme" onLaunched={vi.fn()} />);
    expect(screen.getByRole('button', { name: /run agent/i })).toBeDisabled();
  });

  test('the run launcher shows a library marker for __system agents (B8)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'a1', slug: 'bot', type: 'agent', title: 'Reply Bot', library: false, frontmatter: {}, status: null, parentId: null, createdAt: '', updatedAt: '', lastTouchedAt: null },
            { id: 'op', slug: 'operator', type: 'agent', title: 'Operator', library: true, frontmatter: {}, status: null, parentId: null, createdAt: '', updatedAt: '', lastTouchedAt: null },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
    wrap(<AgentRunLauncher wslug="acme" onLaunched={vi.fn()} />);
    // The library agent's option is labelled with the marker; the local one is not.
    await screen.findByRole('option', { name: /Operator \(library\)/i });
    expect(screen.getByRole('option', { name: /^Reply Bot$/ })).toBeInTheDocument();
  });
});
