import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TriggerAgentField } from './trigger-agent-field.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      for (const [match, build] of Object.entries(handlers)) {
        if (url.includes(match)) return build();
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

// Two agents from the instance-wide /documents?type=agent listing.
const mixedAgents = () =>
  new Response(
    JSON.stringify({
      data: [
        {
          id: 'd1', slug: 'ops', type: 'agent', title: 'Ops Bot',
          status: null, parentId: null, frontmatter: { projects: ['*'] },
          createdAt: '', updatedAt: '', lastTouchedAt: null,
        },
        {
          id: 'op', slug: 'operator', type: 'agent', title: 'Operator',
          status: null, parentId: null, frontmatter: { projects: ['*'] },
          createdAt: '', updatedAt: '', lastTouchedAt: null,
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('TriggerAgentField', () => {
  it('lists every agent the workspace endpoint returns', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({ '/documents?type=agent': mixedAgents });
    render(<TriggerAgentField wslug="acme" value="" onChange={() => {}} />, {
      wrapper: wrap(qc),
    });
    await userEvent.click(screen.getByRole('button', { name: /pick an agent/i }));

    expect(await screen.findByRole('button', { name: /Ops Bot/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Operator/i })).toBeInTheDocument();
  });

  it('clicking an agent calls onChange with the BARE slug (no agent: prefix)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({ '/documents?type=agent': mixedAgents });
    const onChange = vi.fn();
    render(<TriggerAgentField wslug="acme" value="" onChange={onChange} />, {
      wrapper: wrap(qc),
    });
    await userEvent.click(screen.getByRole('button', { name: /pick an agent/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Operator/i }));
    expect(onChange).toHaveBeenCalledWith('operator');
    expect(onChange).not.toHaveBeenCalledWith('agent:operator');
  });

  it('resolves the current slug value to the agent title in the trigger label', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({ '/documents?type=agent': mixedAgents });
    render(<TriggerAgentField wslug="acme" value="ops" onChange={() => {}} />, {
      wrapper: wrap(qc),
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Ops Bot/i })).toBeInTheDocument();
    });
  });

  it('shows a raw $event placeholder value verbatim in the label', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({ '/documents?type=agent': mixedAgents });
    render(<TriggerAgentField wslug="acme" value="$event.agent" onChange={() => {}} />, {
      wrapper: wrap(qc),
    });
    expect(screen.getByRole('button', { name: /\$event\.agent/ })).toBeInTheDocument();
  });
});
