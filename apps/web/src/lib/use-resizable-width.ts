import { useCallback, useRef, useState } from 'react';

interface Opts {
  default: number;
  min: number;
  max: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Pixel width persisted in localStorage, resized by dragging a LEFT-edge handle.
 * The handle sits on the LEFT of a right-anchored panel, so dragging LEFT
 * (smaller clientX) WIDENS it: width += (dragStartX - currentX).
 */
export function useResizableWidth(
  key: string,
  opts: Opts,
): {
  width: number;
  onDragStart: (e: React.PointerEvent) => void;
} {
  const storageKey = `folio:width:${key}`;
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, opts.min, opts.max) : opts.default;
  });
  // Latest width without re-binding move handlers mid-drag.
  const widthRef = useRef(width);
  widthRef.current = width;

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;
      const onMove = (ev: MouseEvent) => {
        const next = clamp(startWidth + (startX - ev.clientX), opts.min, opts.max);
        widthRef.current = next;
        setWidth(next);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        localStorage.setItem(storageKey, String(widthRef.current));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [opts.min, opts.max, storageKey],
  );

  return { width, onDragStart };
}
