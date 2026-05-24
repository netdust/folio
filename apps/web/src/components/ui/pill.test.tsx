import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Pill } from './pill.tsx';

describe('Pill', () => {
  it('dot variant (default) renders dot + text', () => {
    const { container } = render(<Pill category="unstarted" label="Todo" />);
    expect(screen.getByText('Todo')).toBeInTheDocument();
    const dot = container.querySelector('span > span');
    expect(dot?.className ?? '').toMatch(/rounded-full/);
  });

  it('solid variant renders pale background, no dot', () => {
    const { container } = render(<Pill category="unstarted" label="Todo" variant="solid" />);
    expect(screen.getByText('Todo')).toBeInTheDocument();
    const root = container.firstElementChild!;
    expect(root.className).toMatch(/bg-bg-info/);
    const dot = container.querySelector('span > span');
    expect(dot).toBeNull();
  });

  it('honors category color in dot variant', () => {
    const { container } = render(<Pill category="completed" label="Done" />);
    const root = container.firstElementChild!;
    expect(root.className).toMatch(/text-success/);
  });

  it('accepts custom className', () => {
    const { container } = render(<Pill category="backlog" label="x" className="my-custom" />);
    const root = container.firstElementChild!;
    expect(root.className).toMatch(/my-custom/);
  });
});
