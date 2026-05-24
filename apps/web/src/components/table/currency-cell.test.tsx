import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldRenderer } from '../slideover/field-renderer.tsx';

describe('FieldRenderer currency', () => {
  it('renders the value formatted with the currency symbol', () => {
    render(
      <FieldRenderer
        fieldKey="amount"
        type="currency"
        value={1250}
        options={['EUR']}
        onCommit={() => {}}
      />
    );
    // Locale-dependent formatting — assert the digits and symbol both present.
    const node = screen.getByText(/1[\.,]250/);
    const txt = node.textContent ?? '';
    expect(txt).toMatch(/€/);
  });

  it('renders empty when value is null', () => {
    const { container } = render(
      <FieldRenderer fieldKey="amount" type="currency" value={null} options={['EUR']} onCommit={() => {}} />
    );
    // Display-mode element exists but contains no digit.
    expect(container.textContent ?? '').not.toMatch(/\d/);
  });

  it('commits a parsed number when the user types and blurs', () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer fieldKey="amount" type="currency" value={100} options={['EUR']} onCommit={onCommit} />
    );
    fireEvent.click(screen.getByText(/€/));   // enter edit mode
    const input = screen.getByRole('spinbutton', { name: 'amount' });
    fireEvent.change(input, { target: { value: '350' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(350);
  });

  it('does not commit on blur when the value is unchanged', () => {
    const onCommit = vi.fn();
    render(
      <FieldRenderer fieldKey="amount" type="currency" value={100} options={['EUR']} onCommit={onCommit} />
    );
    fireEvent.click(screen.getByText(/€/));
    const input = screen.getByRole('spinbutton', { name: 'amount' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
