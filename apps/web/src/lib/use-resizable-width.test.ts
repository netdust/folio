import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResizableWidth } from './use-resizable-width.ts';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useResizableWidth', () => {
  test('returns the default width when nothing is stored', () => {
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    expect(result.current.width).toBe(480);
  });

  test('restores a persisted width from localStorage (clamped to min/max)', () => {
    localStorage.setItem('folio:width:k', '5000'); // above max
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    expect(result.current.width).toBe(900);
  });

  test('a left-drag widens the panel and clamps + persists', () => {
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    // onDragStart receives a pointerdown at clientX=1000; the handle is on the
    // slideover's LEFT edge, so moving the pointer LEFT (smaller clientX)
    // widens it. Simulate a move to clientX=900 → +100px → 580.
    act(() => {
      result.current.onDragStart({ clientX: 1000, preventDefault() {}, } as unknown as React.PointerEvent);
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 900 } as MouseEventInit));
      window.dispatchEvent(new MouseEvent('pointerup', {} as MouseEventInit));
    });
    expect(result.current.width).toBe(580);
    expect(localStorage.getItem('folio:width:k')).toBe('580');
  });

  test('clamps to max on a large drag', () => {
    const { result } = renderHook(() => useResizableWidth('k', { default: 480, min: 360, max: 900 }));
    act(() => {
      result.current.onDragStart({ clientX: 1000, preventDefault() {} } as unknown as React.PointerEvent);
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0 } as MouseEventInit)); // +1000 → clamp 900
      window.dispatchEvent(new MouseEvent('pointerup', {} as MouseEventInit));
    });
    expect(result.current.width).toBe(900);
  });
});
