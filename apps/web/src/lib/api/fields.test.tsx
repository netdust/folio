import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fieldsKeys,
  useCreateField,
  useDeleteField,
  useUpdateField,
} from './fields.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fieldsKeys', () => {
  it('list key includes wslug, pslug and tslug', () => {
    expect(fieldsKeys.list('acme', 'sales', 'work-items')).toEqual([
      'fields',
      'acme',
      'sales',
      'work-items',
    ]);
  });
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useCreateField', () => {
  it('POSTs to the table-scoped fields endpoint and returns the created field', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(
          JSON.stringify({ data: { field: { id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['low', 'high'], required: false, order: 0 } } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const { result } = renderHook(() => useCreateField('acme', 'sales', 'work-items'), { wrapper: wrap(qc) });
    const created = await result.current.mutateAsync({ key: 'priority', type: 'select', label: 'Priority', options: ['low', 'high'] });

    expect(calls[0].url).toContain('/api/v1/w/acme/p/sales/t/work-items/fields');
    expect(calls[0].body).toEqual({ key: 'priority', type: 'select', label: 'Priority', options: ['low', 'high'] });
    expect(created.id).toBe('f1');
  });
});

describe('useUpdateField', () => {
  it('PATCHes /fields/:id with the supplied patch and returns the updated field', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return new Response(
          JSON.stringify({ data: { field: { id: 'f1', key: 'priority', type: 'select', label: 'Priority renamed', options: ['low', 'high'], required: false, order: 0 } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const { result } = renderHook(() => useUpdateField('acme', 'sales', 'work-items'), { wrapper: wrap(qc) });
    const updated = await result.current.mutateAsync({ id: 'f1', patch: { label: 'Priority renamed' } });

    expect(calls[0].url).toContain('/api/v1/w/acme/p/sales/t/work-items/fields/f1');
    expect(calls[0].method).toBe('PATCH');
    expect(updated.label).toBe('Priority renamed');
    expect(updated.id).toBe('f1');
  });
});

describe('useDeleteField', () => {
  it('DELETEs /fields/:id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return new Response(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteField('acme', 'sales', 'work-items'), { wrapper: wrap(qc) });
    await result.current.mutateAsync('f1');

    expect(calls[0].url).toContain('/api/v1/w/acme/p/sales/t/work-items/fields/f1');
    expect(calls[0].method).toBe('DELETE');
  });
});
