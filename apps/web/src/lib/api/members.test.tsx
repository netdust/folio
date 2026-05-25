import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMembers, membersKeys } from './members.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('membersKeys', () => {
  it('list key includes wslug', () => {
    expect(membersKeys.list('acme')).toEqual(['members', 'acme']);
  });
});

describe('useMembers', () => {
  it('GETs /api/v1/w/:wslug/members and unwraps members[]', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({
            data: {
              members: [
                { id: 'u1', email: 'alice@test', name: 'Alice', role: 'owner' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const { result } = renderHook(() => useMembers('acme'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls[0]).toContain('/api/v1/w/acme/members');
    expect(result.current.data?.[0]?.email).toBe('alice@test');
  });

  it('is disabled when wslug is empty', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useMembers(''), { wrapper: wrap(qc) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
