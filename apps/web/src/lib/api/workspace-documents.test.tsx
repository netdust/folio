import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useWorkspaceDocumentEvents,
  useWorkspaceLogActivity,
} from './workspace-documents.ts';

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useWorkspaceDocumentEvents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches workspace-scoped events from /api/v1/w/:wslug/documents/:slug/events', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith('/w/acme/documents/triage/events')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'e1', kind: 'activity.logged', actor: 'u1', payload: { note: 'hi' }, createdAt: '2026-01-01' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useWorkspaceDocumentEvents('acme', 'triage'), {
      wrapper: wrapperOf(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].kind).toBe('activity.logged');

    // No pslug in the URL — sanity check the request itself.
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((c) => c.endsWith('/w/acme/documents/triage/events'))).toBe(true);
    expect(calls.some((c) => c.includes('/p/'))).toBe(false);
  });

  it('disabled when slug is undefined', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderHook(() => useWorkspaceDocumentEvents('acme', undefined), {
      wrapper: wrapperOf(qc),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceLogActivity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs to /api/v1/w/:wslug/documents/:slug/activity (no pslug) and invalidates scoped keys', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/activity') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ data: { lastTouchedAt: new Date().toISOString() } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useWorkspaceLogActivity('acme'), {
      wrapper: wrapperOf(qc),
    });

    await result.current.mutateAsync({ slug: 'triage', note: 'Ran cron' });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());

    // URL must NOT include /p/ (workspace-scoped, not project-scoped).
    const postCalls = fetchMock.mock.calls.filter(
      ([_url, init]) => init?.method === 'POST',
    );
    expect(postCalls).toHaveLength(1);
    expect(String(postCalls[0][0])).toMatch(/\/w\/acme\/documents\/triage\/activity$/);
    expect(String(postCalls[0][0])).not.toMatch(/\/p\//);

    const keys = invalidateSpy.mock.calls.map(([opts]) =>
      JSON.stringify((opts as { queryKey: readonly unknown[] }).queryKey),
    );

    // Must invalidate the workspace events list — distinct key prefix from
    // project-scoped ['document-events'].
    expect(keys.some((k) =>
      k === JSON.stringify(['workspace-document-events', 'acme', 'triage']),
    )).toBe(true);

    // Must invalidate the workspace doc detail and list, both no pslug.
    expect(keys.some((k) =>
      k === JSON.stringify(['workspace-documents', 'acme', 'detail', 'triage']),
    )).toBe(true);
    expect(keys.some((k) =>
      k === JSON.stringify(['workspace-documents', 'acme', 'list']),
    )).toBe(true);

    // Broad ['workspace-documents'] prefix must NOT be invalidated alone — would
    // nuke every workspace's caches across open tabs.
    expect(keys.some((k) => k === JSON.stringify(['workspace-documents']))).toBe(false);
  });
});
