import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.ts';
import { completeAi } from './ai-complete.ts';

describe('completeAi client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the current body to /w/:wslug/ai/complete and returns the unwrapped { text }', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { text: '# Drafted body' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await completeAi('acme', {
      action: 'summarize',
      content: 'the body to summarize',
      title: 'My Doc',
    });

    expect(result).toEqual({ text: '# Drafted body' });
    // Crosses the real client→fetch boundary (no mock of the client itself).
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/w/acme/ai/complete');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      action: 'summarize',
      content: 'the body to summarize',
      title: 'My Doc',
    });
  });

  it('omits title/instruction when not provided', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { text: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await completeAi('acme', { action: 'draft', content: 'body' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ action: 'draft', content: 'body' });
  });

  it('propagates a server error as ApiError (caller surfaces the toast)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'AI_NOT_CONFIGURED', message: 'no key' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    await expect(completeAi('acme', { action: 'draft', content: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
