import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useWorkspaces, workspacesKeys } from './workspaces.ts';

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useWorkspaces', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              workspace: {
                id: 'w1',
                slug: 'main',
                name: 'Main',
                createdAt: '2026-01-01',
                updatedAt: '2026-01-01',
              },
              role: 'owner',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and unwraps the data envelope as membership rows', async () => {
    const { result } = renderHook(() => useWorkspaces(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.workspace.slug).toBe('main');
    expect(result.current.data?.[0]?.role).toBe('owner');
  });

  it('uses the expected query key', () => {
    expect(workspacesKeys.list()).toEqual(['workspaces', 'list']);
  });
});
