import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useGrantAccess, useRevokeAccess } from './instance-access.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubFetch(calls: { url: string; method: string; body: unknown }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('useGrantAccess', () => {
  it('POSTs /api/v1/instance/access with a workspace grant', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubFetch(calls);
    const { result } = renderHook(() => useGrantAccess(), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ userId: 'u1', workspaceId: 'w1' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/api/v1/instance/access');
    expect(calls[0]!.body).toEqual({ userId: 'u1', workspaceId: 'w1' });
  });
});

describe('useRevokeAccess', () => {
  it('DELETEs /api/v1/instance/access WITH a body (project grant)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubFetch(calls);
    const { result } = renderHook(() => useRevokeAccess(), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ userId: 'u1', projectId: 'p1' });
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/api/v1/instance/access');
    // The revoke target rides the BODY, not the path — the regression this guards.
    expect(calls[0]!.body).toEqual({ userId: 'u1', projectId: 'p1' });
  });
});
