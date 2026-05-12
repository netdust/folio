import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton } from './skeleton.tsx';

describe('Skeleton', () => {
  it('renders an aria-hidden block with pulse animation', () => {
    const { container } = render(<Skeleton width={120} height={14} />);
    const el = container.firstElementChild!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.className).toMatch(/animate-pulse/);
    expect(el.className).toMatch(/bg-card/);
  });

  it('applies the rounded variant', () => {
    const { container } = render(<Skeleton rounded="pill" width={50} height={14} />);
    expect(container.firstElementChild!.className).toMatch(/rounded-pill/);
  });
});
