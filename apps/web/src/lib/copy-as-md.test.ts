import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchDocumentMarkdown, copyDocumentAsMarkdown } from './copy-as-md.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDocumentMarkdown', () => {
  it('fetches the raw .md endpoint without envelope-unwrapping', async () => {
    const body = '---\ntitle: Hello\n---\n\nBody text.\n';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        }),
      ),
    );

    const result = await fetchDocumentMarkdown('ws1', 'proj1', 'hello');
    expect(result).toBe(body);
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/w/ws1/p/proj1/documents/hello.md',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('copyDocumentAsMarkdown', () => {
  it('writes the fetched markdown to the clipboard', async () => {
    const body = '---\ntitle: Hello\n---\n\nBody text.\n';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        }),
      ),
    );

    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await copyDocumentAsMarkdown('ws1', 'proj1', 'hello');
    expect(writeText).toHaveBeenCalledWith(body);
  });
});
