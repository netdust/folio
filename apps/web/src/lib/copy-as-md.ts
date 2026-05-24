import { client } from './api/client.ts';

/**
 * Fetch a document's raw markdown representation from the server.
 * Uses `client.getRaw` so the response is returned as a string
 * without envelope-unwrapping.
 */
export async function fetchDocumentMarkdown(
  wslug: string,
  pslug: string,
  slug: string,
): Promise<string> {
  return client.getRaw(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}.md`);
}

/**
 * Fetch a document as markdown and write it to the clipboard.
 * Throws on network failure or clipboard denial — callers should catch
 * and surface via toast.
 */
export async function copyDocumentAsMarkdown(
  wslug: string,
  pslug: string,
  slug: string,
): Promise<void> {
  const md = await fetchDocumentMarkdown(wslug, pslug, slug);
  await navigator.clipboard.writeText(md);
}
