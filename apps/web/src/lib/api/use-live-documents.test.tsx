import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    invalidateSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes with the project ID (not slug) + document kinds, and invalidates the project-wide document prefix', () => {
    // The events route filters ?project= by document-row projectId, so the SSE
    // filter MUST carry the project ID. The cache key is slug-based.
    renderHook(() => useLiveDocuments('acme', 'web', 'proj-id-123'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toMatchObject({
      project: 'proj-id-123',
      kinds: ['document.created', 'document.updated', 'document.deleted'],
    });
    // Regression guard: the filter must NOT be the slug.
    expect((calls[0]!.filters as { project: string }).project).not.toBe('web');

    calls[0]!.onEvent({ kind: 'document.updated' });
    // Debounced trailing edge: nothing fires synchronously...
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    // ...it fires once the 250ms window elapses. The SSE event does not carry
    // the changed doc's table, so the live-update invalidates the table-agnostic
    // project prefix [documents, w, p] — which prefix-matches every table's list
    // key [documents, w, p, <tslug>, 'list', <params>].
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['documents', 'acme', 'web'] });
  });

  it('debounces an event burst to ONE trailing invalidation', () => {
    // An agent write-burst fires many document events in quick succession. The
    // 250ms trailing debounce must collapse them to a single refetch.
    renderHook(() => useLiveDocuments('acme', 'web', 'proj-id-123'));
    const fire = calls[0]!.onEvent;

    fire({ kind: 'document.created' });
    vi.advanceTimersByTime(100);
    fire({ kind: 'document.updated' });
    vi.advanceTimersByTime(100);
    fire({ kind: 'document.updated' });
    // Three events within the window, none past 250ms yet → no invalidation.
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    // Exactly ONE trailing invalidation for the whole burst, not three.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['documents', 'acme', 'web'] });
  });

  it('does not open a mis-scoped subscription before the project id resolves', () => {
    // projectId undefined (project query still loading) → no filter with an
    // empty/slug project; the hook should pass project: undefined so buildQuery
    // omits it rather than subscribing to the wrong scope.
    renderHook(() => useLiveDocuments('acme', 'web', undefined));
    expect(calls).toHaveLength(1);
    expect((calls[0]!.filters as { project?: string }).project).toBeUndefined();
  });
});
