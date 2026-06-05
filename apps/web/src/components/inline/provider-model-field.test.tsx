import { describe, expect, it, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ProviderModelField } from './provider-model-field.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function stubFetch(opts: { providersWithKeys: string[]; claudeCodeEnabled?: boolean }) {
  const keys = opts.providersWithKeys.map((p, i) => ({
    id: `k${i}`,
    workspaceId: 'w1',
    provider: p,
    label: 'default',
    baseUrl: null,
    createdAt: '2026-01-01',
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname === '/api/v1/w/ws') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'w1',
              slug: 'ws',
              name: 'WS',
              ...(opts.claudeCodeEnabled !== undefined
                ? { claude_code_enabled: opts.claudeCodeEnabled }
                : {}),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.pathname === '/api/v1/instance/ai-keys') {
        return new Response(JSON.stringify({ data: { keys } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function Host({ initial }: { initial: { provider: string; model: string } }) {
  const [state, setState] = useState(initial);
  return (
    <ProviderModelField
      wslug="ws"
      provider={state.provider}
      model={state.model}
      onChange={setState}
    />
  );
}

describe('ProviderModelField', () => {
  it('renders provider label and model name', async () => {
    stubFetch({ providersWithKeys: ['anthropic'] });
    render(
      <Host initial={{ provider: 'anthropic', model: 'claude-haiku-4-5' }} />,
      { wrapper: wrap(newQc()) },
    );
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'claude-haiku-4-5' })).toBeInTheDocument();
  });

  it('marks providers with no configured AI key', async () => {
    stubFetch({ providersWithKeys: ['anthropic'] });
    render(
      <Host initial={{ provider: 'openai', model: 'gpt-4o' }} />,
      { wrapper: wrap(newQc()) },
    );
    // Trigger button surfaces the "no key" badge since the workspace only has
    // an anthropic key configured. The trigger renders OpenAI label + badge.
    const trigger = await screen.findByRole('button', { name: /OpenAI/ });
    expect(trigger).toBeInTheDocument();
    // The badge is part of the same button; "no key" appears inside it.
    expect(trigger.textContent).toMatch(/no key/);
  });

  it('switching provider resets model when current model is not in new provider list', async () => {
    stubFetch({ providersWithKeys: ['anthropic', 'openai'] });
    const onChange = vi.fn();
    function Local() {
      const [state, setState] = useState({ provider: 'anthropic', model: 'claude-haiku-4-5' });
      return (
        <ProviderModelField
          wslug="ws"
          provider={state.provider}
          model={state.model}
          onChange={(next) => {
            onChange(next);
            setState(next);
          }}
        />
      );
    }
    render(<Local />, { wrapper: wrap(newQc()) });
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }));
    await userEvent.click(screen.getByRole('button', { name: /OpenAI$/ }));
    // First OpenAI model in the catalogue: gpt-4o.
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'openai', model: 'gpt-4o' });
  });

  it('openrouter renders model as a free-text input', async () => {
    stubFetch({ providersWithKeys: ['openrouter'] });
    render(
      <Host initial={{ provider: 'openrouter', model: 'mistralai/mixtral' }} />,
      { wrapper: wrap(newQc()) },
    );
    const input = screen.getByPlaceholderText('model name') as HTMLInputElement;
    expect(input.value).toBe('mistralai/mixtral');
  });

  it('hides the claude-code option when claude_code_enabled is false/absent', async () => {
    stubFetch({ providersWithKeys: ['anthropic'], claudeCodeEnabled: false });
    render(
      <Host initial={{ provider: 'anthropic', model: 'claude-haiku-4-5' }} />,
      { wrapper: wrap(newQc()) },
    );
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }));
    expect(screen.queryByRole('button', { name: /claude code/i })).not.toBeInTheDocument();
  });

  it('shows the claude-code option when claude_code_enabled is true', async () => {
    stubFetch({ providersWithKeys: ['anthropic'], claudeCodeEnabled: true });
    render(
      <Host initial={{ provider: 'anthropic', model: 'claude-haiku-4-5' }} />,
      { wrapper: wrap(newQc()) },
    );
    await userEvent.click(screen.getByRole('button', { name: /Anthropic/ }));
    expect(await screen.findByRole('button', { name: /claude code/i })).toBeInTheDocument();
  });
});
