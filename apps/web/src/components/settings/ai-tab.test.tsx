import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiTab } from './ai-tab.tsx';
import {
  useWorkspaceAiKeys,
  useUpsertAiKey,
  useDeleteAiKey,
} from '../../lib/api/settings.ts';

const mockTestMutate = vi.fn(async () => ({ ok: true } as const));
vi.mock('../../lib/api/ai-test-key.ts', () => ({
  useTestKey: () => ({ mutateAsync: mockTestMutate, isPending: false }),
}));

vi.mock('../../lib/api/settings.ts', () => ({
  useWorkspaceAiKeys: vi.fn(() => ({ data: [], isLoading: false })),
  useUpsertAiKey: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteAiKey: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiTab wslug="acme" workspaceId="ws_1" />
    </QueryClientProvider>,
  );
}

describe('AiTab', () => {
  beforeEach(() => {
    mockTestMutate.mockClear();
    vi.mocked(useWorkspaceAiKeys).mockReturnValue({ data: [], isLoading: false } as never);
    vi.mocked(useUpsertAiKey).mockReturnValue({
      mutateAsync: vi.fn(async () => ({ ok: true })),
      isPending: false,
    } as never);
    vi.mocked(useDeleteAiKey).mockReturnValue({
      mutateAsync: vi.fn(async () => ({ ok: true })),
      isPending: false,
    } as never);
  });

  test('renders the four provider options', () => {
    renderTab();
    const sel = screen.getByLabelText(/provider/i);
    expect(sel.querySelectorAll('option')).toHaveLength(4);
    expect(screen.getByRole('option', { name: 'anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'openai' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'openrouter' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'ollama' })).toBeInTheDocument();
  });

  test('Save key is disabled until a key is entered', () => {
    renderTab();
    const save = screen.getByRole('button', { name: /save key/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    expect(save).toBeEnabled();
  });

  test('clicking Test calls the mutation and shows ok feedback', async () => {
    renderTab();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/key validated/i)).toBeInTheDocument());
    expect(mockTestMutate).toHaveBeenCalledTimes(1);
  });

  // B round 2 fix #8 — if the user switches the provider dropdown while a
  // Test mutation is in flight, the resolved Anthropic result must NOT paint
  // '✓ Key validated' onto the now-visible OpenAI panel.
  test('Test result does not paint after provider switches mid-flight', async () => {
    let resolveTest: (v: { ok: true } | { ok: false; reason: string }) => void = () => {};
    mockTestMutate.mockImplementationOnce(
      () =>
        new Promise<{ ok: true } | { ok: false; reason: string }>((res) => {
          resolveTest = res;
        }),
    );

    renderTab();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-anthropic' } });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));

    // Switch provider before the mutation resolves.
    fireEvent.change(screen.getByLabelText(/provider/i), { target: { value: 'openai' } });

    // Now resolve the original (Anthropic) mutation.
    resolveTest({ ok: true });

    // Give react-query a tick to flush; assert nothing paints.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/key validated/i)).not.toBeInTheDocument();
  });

  test('shows ollama base URL field only when ollama is selected', () => {
    renderTab();
    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/provider/i), { target: { value: 'ollama' } });
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
  });

  test('switching provider clears the API key field', () => {
    renderTab();
    const apiKeyInput = screen.getByLabelText(/api key/i) as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: 'sk-ant-test' } });
    expect(apiKeyInput.value).toBe('sk-ant-test');
    expect(screen.getByRole('button', { name: /save key/i })).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/provider/i), { target: { value: 'openai' } });

    expect((screen.getByLabelText(/api key/i) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
  });

  test('upsert passes label="default" to the mutation', async () => {
    const upsertSpy = vi.fn(async () => ({ ok: true }));
    vi.mocked(useUpsertAiKey).mockReturnValue({
      mutateAsync: upsertSpy,
      isPending: false,
    } as never);
    renderTab();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => expect(upsertSpy).toHaveBeenCalled());
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        apiKey: 'sk-test',
        label: 'default',
      }),
    );
  });

  test('configured keys list ignores non-default labels', () => {
    vi.mocked(useWorkspaceAiKeys).mockReturnValue({
      data: [
        {
          id: 'k1',
          workspaceId: 'ws_1',
          provider: 'anthropic',
          label: 'default',
          baseUrl: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'k2',
          workspaceId: 'ws_1',
          provider: 'anthropic',
          label: 'prod',
          baseUrl: null,
          createdAt: '2026-01-02T00:00:00Z',
        },
        {
          id: 'k3',
          workspaceId: 'ws_1',
          provider: 'openai',
          label: 'prod',
          baseUrl: null,
          createdAt: '2026-01-03T00:00:00Z',
        },
      ],
      isLoading: false,
    } as never);
    const { container } = renderTab();
    // The anthropic row shows saved (k1, default). OpenAI shows NOT configured because
    // its only key is label='prod', which the UI ignores.
    const rows = container.querySelectorAll('ul > li');
    const rowByProvider = (name: string) =>
      Array.from(rows).find((li) => li.querySelector('span.font-medium')?.textContent === name);
    const anthropicRow = rowByProvider('anthropic');
    const openaiRow = rowByProvider('openai');
    expect(anthropicRow?.textContent).toMatch(/✓ saved/);
    expect(openaiRow?.textContent).toMatch(/not configured/);
  });
});
