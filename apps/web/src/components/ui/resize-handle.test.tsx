import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResizeHandle } from './resize-handle.tsx';

describe('ResizeHandle', () => {
  test('renders a vertical separator and fires onDragStart on pointer down', () => {
    const onDragStart = vi.fn();
    render(<ResizeHandle onDragStart={onDragStart} />);
    const handle = screen.getByRole('separator', { name: /resize/i });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    fireEvent.pointerDown(handle);
    expect(onDragStart).toHaveBeenCalled();
  });
});
