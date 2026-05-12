import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, client } from './client.ts';

describe('client envelope unwrap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('unwraps a pure { data: T } envelope', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: { name: 'Alice' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const result = await client.get<{ name: string }>('/api/v1/x');
    expect(result).toEqual({ name: 'Alice' });
  });

  it('preserves sibling keys when { data, nextCursor } shape is returned', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [1, 2, 3], nextCursor: 'abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const result = await client.get<{ data: number[]; nextCursor: string | null }>('/api/v1/x');
    expect(result).toEqual({ data: [1, 2, 3], nextCursor: 'abc' });
  });

  it('returns raw object if no `data` key at all', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const result = await client.get<{ ok: boolean }>('/api/v1/x');
    expect(result).toEqual({ ok: true });
  });

  it('returns text on text/markdown response', async () => {
    global.fetch = vi.fn(async () =>
      new Response('---\ntitle: x\n---\n# Body', {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      }),
    ) as unknown as typeof fetch;
    const result = await client.getRaw('/api/v1/x.md');
    expect(result).toMatch(/^---/);
    expect(result).toContain('# Body');
  });

  it('returns undefined on 204', async () => {
    global.fetch = vi.fn(async () =>
      new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const result = await client.delete<void>('/api/v1/x');
    expect(result).toBeUndefined();
  });

  it('throws ApiError on non-2xx with parsed body', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'BOOM', message: 'oops' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    await expect(client.get('/api/v1/x')).rejects.toBeInstanceOf(ApiError);
    await expect(client.get('/api/v1/x')).rejects.toMatchObject({
      status: 500,
      body: { error: { code: 'BOOM', message: 'oops' } },
    });
  });
});
