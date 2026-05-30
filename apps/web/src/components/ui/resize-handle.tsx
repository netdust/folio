import { cn } from './cn.ts';

interface Props {
  onDragStart: (e: React.PointerEvent) => void;
  className?: string;
}

/**
 * Thin, full-height drag affordance pinned to the LEFT edge of a right-anchored
 * panel. Holds no drag state itself — `onDragStart` (e.g. from useResizableWidth)
 * owns the gesture; this is just the surface that initiates it on pointerdown.
 */
export function ResizeHandle({ onDragStart, className }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onPointerDown={onDragStart}
      className={cn(
        'absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/30',
        className,
      )}
    />
  );
}
