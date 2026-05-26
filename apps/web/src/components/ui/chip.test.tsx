import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chip } from './chip.tsx';

describe('Chip primitive', () => {
  it('renders children inside a <span> when no onClick is provided', () => {
    const { container } = render(<Chip>project-a</Chip>);
    expect(screen.getByText('project-a')).toBeInTheDocument();
    // No <button> in the DOM → it's a passive label.
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('renders a <button> when onClick is provided', async () => {
    const onClick = vi.fn();
    render(<Chip onClick={onClick}>folio</Chip>);
    const btn = screen.getByRole('button', { name: 'folio' });
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('default variant has a visible border at rest (border-border-light class)', () => {
    const { container } = render(<Chip>project-a</Chip>);
    const chip = container.firstElementChild as HTMLElement;
    const classes = chip.className.split(/\s+/);
    // Use word-boundary class checks so a future drift (border-border vs
    // border-border-light, rounded-md vs rounded-full) doesn't silently pass.
    expect(classes).toContain('border-border-light'); // BUG-012: lighter than border-border
    expect(classes).toContain('rounded-md');          // BUG-012: not rounded-full
    // Must NOT carry a primary tint at rest — that's the BUG-008/011 regression
    // we explicitly do not want.
    expect(chip.className).not.toContain('bg-primary/10');
  });

  it('muted variant has no border and uses fg-3 text color', () => {
    const { container } = render(<Chip muted>removed</Chip>);
    const chip = container.firstElementChild as HTMLElement;
    const classes = chip.className.split(/\s+/);
    expect(classes).toContain('text-fg-3');
    expect(classes).not.toContain('border-border-light');
    expect(classes).not.toContain('border-border');
  });

  it('mono variant adds font-mono', () => {
    const { container } = render(<Chip mono>list_documents</Chip>);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain('font-mono');
  });

  it('muted + mono compose', () => {
    const { container } = render(
      <Chip muted mono>
        deadbeef·removed
      </Chip>,
    );
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain('text-fg-3');
    expect(chip.className).toContain('font-mono');
    expect(chip.className).not.toContain('border-border');
  });

  it('clickable default chip gets a primary hover tint', () => {
    const { container } = render(<Chip onClick={() => {}}>folio</Chip>);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toMatch(/hover:.*primary/);
  });

  it('forwards extra props (aria-label, data-testid) to the underlying element', () => {
    render(
      <Chip onClick={() => {}} aria-label="project folio" data-testid="proj-chip">
        folio
      </Chip>,
    );
    const btn = screen.getByTestId('proj-chip');
    expect(btn).toHaveAttribute('aria-label', 'project folio');
  });

  it('forwardRef attaches to the underlying button when clickable', () => {
    let captured: HTMLButtonElement | null = null;
    render(
      <Chip
        ref={(el) => {
          captured = el;
        }}
        onClick={() => {}}
      >
        folio
      </Chip>,
    );
    expect(captured).toBeInstanceOf(HTMLButtonElement);
  });
});
