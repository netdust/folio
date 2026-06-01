import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const calls: { filters: unknown; onEvent: (e: unknown) => void }[] = [];
vi.mock('./event-stream.ts', () => ({
  useEventStream: (_w: string, filters: unknown, onEvent: (e: unknown) => void) => {
    calls.push({ filters, onEvent });
  },
}));
const invalidateSpy = vi.fn();
vi.mock('@tanstack/react-query', async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, useQueryClient: () => ({ invalidateQueries: invalidateSpy }) };
});

import { useLiveDocuments } from './use-live-documents.ts';

describe('useLiveDocuments', () => {
  it('subscribes with project filter + document kinds and invalidates list key on event', () => {
    calls.length = 0; invalidateSpy.mockClear();
    renderHook(() => useLiveDocuments('acme', 'web'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toMatchObject({
      project: 'web',
      kinds: ['document.created', 'document.updated', 'document.deleted'],
    });
    calls[0]!.onEvent({ kind: 'document.updated' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['documents', 'acme', 'web', 'list'] });
  });
});
