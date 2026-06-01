import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Capture the onEvent + filters the hook passes to useEventStream.
const calls: { filters: unknown; onEvent: (e: unknown) => void }[] = [];
vi.mock('./api/event-stream.ts', () => ({
  useEventStream: (_w: string, filters: unknown, onEvent: (e: unknown) => void) => {
    calls.push({ filters, onEvent });
  },
}));

import { useLiveDocument } from './use-live-document.ts';

describe('useLiveDocument (notify-don\'t-stomp)', () => {
  it('subscribes to document.updated + document.deleted', () => {
    calls.length = 0;
    renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: false, onRefetch: vi.fn() }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toMatchObject({ kinds: ['document.updated', 'document.deleted'] });
  });

  it('clean draft + document.updated → refetch, no banner', () => {
    calls.length = 0;
    const onRefetch = vi.fn();
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: false, onRefetch }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'd1' }));
    expect(onRefetch).toHaveBeenCalledTimes(1);
    expect(result.current.externalUpdate).toBeNull();
  });

  it('dirty draft + document.updated → banner, NO refetch (no stomp)', () => {
    calls.length = 0;
    const onRefetch = vi.fn();
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: true, onRefetch }),
    );
    act(() =>
      calls[0]!.onEvent({ kind: 'document.updated', documentId: 'd1', actor: 'agent:helper' }),
    );
    expect(onRefetch).not.toHaveBeenCalled();
    expect(result.current.externalUpdate).toMatchObject({ kind: 'updated', actor: 'agent:helper' });
  });

  it('document.deleted → deleted banner regardless of dirty', () => {
    calls.length = 0;
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: false, onRefetch: vi.fn() }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.deleted', documentId: 'd1' }));
    expect(result.current.externalUpdate).toMatchObject({ kind: 'deleted' });
  });

  it('ignores events for a different document id', () => {
    calls.length = 0;
    const onRefetch = vi.fn();
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: false, onRefetch }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'OTHER' }));
    expect(onRefetch).not.toHaveBeenCalled();
    expect(result.current.externalUpdate).toBeNull();
  });

  it('clears a stale updated banner when the draft goes clean (user saved)', () => {
    calls.length = 0;
    let dirty = true;
    const { result, rerender } = renderHook(
      ({ isDirty }) => useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty, onRefetch: vi.fn() }),
      { initialProps: { isDirty: dirty } },
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'd1' }));
    expect(result.current.externalUpdate).toMatchObject({ kind: 'updated' });
    // User saves → draft becomes clean → stale banner clears.
    dirty = false;
    rerender({ isDirty: dirty });
    expect(result.current.externalUpdate).toBeNull();
  });

  it('keeps a deleted banner even when the draft is clean', () => {
    calls.length = 0;
    const { result, rerender } = renderHook(
      ({ isDirty }) => useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty, onRefetch: vi.fn() }),
      { initialProps: { isDirty: false } },
    );
    act(() => calls[0]!.onEvent({ kind: 'document.deleted', documentId: 'd1' }));
    expect(result.current.externalUpdate).toMatchObject({ kind: 'deleted' });
    rerender({ isDirty: false });
    expect(result.current.externalUpdate).toMatchObject({ kind: 'deleted' });
  });

  it('dismiss clears the banner', () => {
    calls.length = 0;
    const { result } = renderHook(() =>
      useLiveDocument({ wslug: 'acme', docId: 'd1', isDirty: true, onRefetch: vi.fn() }),
    );
    act(() => calls[0]!.onEvent({ kind: 'document.updated', documentId: 'd1' }));
    expect(result.current.externalUpdate).not.toBeNull();
    act(() => result.current.dismiss());
    expect(result.current.externalUpdate).toBeNull();
  });
});
