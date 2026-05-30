import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizableWidthOpts {
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
  opts: ResizableWidthOpts,
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
  // Teardown for the in-flight drag (unbinds listeners + persists). Lets a
  // second drag start, a pointercancel, or an unmount clean up the prior gesture.
  const teardownRef = useRef<(() => void) | null>(null);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      // Tear down any in-flight drag before binding a fresh pair, so an
      // interrupted/re-pressed gesture never accumulates ghost listeners.
      teardownRef.current?.();

      const startX = e.clientX;
      const startWidth = widthRef.current;
      const onMove = (ev: PointerEvent) => {
        const next = clamp(startWidth + (startX - ev.clientX), opts.min, opts.max);
        widthRef.current = next;
        setWidth(next);
      };
      const teardown = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        teardownRef.current = null;
        localStorage.setItem(storageKey, String(widthRef.current));
      };
      const onEnd = (_ev: PointerEvent) => teardown();

      teardownRef.current = teardown;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [opts.min, opts.max, storageKey],
  );

  // On unmount mid-drag, run whatever teardown is active (unbinds + persists).
  useEffect(() => () => teardownRef.current?.(), []);

  return { width, onDragStart };
}
