import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiTab } from './ai-tab.tsx';

const mockTestMutate = vi.fn(async () => ({ ok: true } as const));
vi.mock('../../lib/api/ai-test-key.ts', () => ({
  useTestKey: () => ({ mutateAsync: mockTestMutate, isPending: false }),
}));

vi.mock('../../lib/api/settings.ts', () => ({
  useWorkspaceAiKeys: () => ({ data: [], isLoading: false }),
  useUpsertAiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteAiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    expect(mockTestMutate).toHaveBeenCalled();
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
});
