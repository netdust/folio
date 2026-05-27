import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TabStrip } from './tab-strip.tsx';

describe('TabStrip', () => {
  const items = [
    { value: 'fields' as const, label: 'Fields', icon: '📋' },
    { value: 'comments' as const, label: 'Comments', icon: '💬', count: 4 },
    { value: 'activity' as const, label: 'Activity', icon: '📜' },
  ];

  it('renders all items with labels + icons', () => {
    render(<TabStrip value="fields" items={items} onChange={() => {}} />);
    expect(screen.getByText('Fields')).toBeInTheDocument();
    expect(screen.getByText('Comments')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument(); // count badge
  });

  it('fires onChange on click', () => {
    const onChange = vi.fn();
    render(<TabStrip value="fields" items={items} onChange={onChange} />);
    fireEvent.click(screen.getByText('Comments'));
    expect(onChange).toHaveBeenCalledWith('comments');
  });

  it('does not fire onChange when clicking the active tab', () => {
    const onChange = vi.fn();
    render(<TabStrip value="comments" items={items} onChange={onChange} />);
    fireEvent.click(screen.getByText('Comments'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders aria-pressed=true on active tab', () => {
    render(<TabStrip value="comments" items={items} onChange={() => {}} />);
    expect(screen.getByText('Comments').closest('button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Fields').closest('button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides count badge when count is undefined', () => {
    render(<TabStrip value="fields" items={items} onChange={() => {}} />);
    const activityBtn = screen.getByText('Activity').closest('button')!;
    expect(activityBtn.textContent).not.toMatch(/\d/);
  });

  it('hides count badge when count is zero', () => {
    const zeroItems = [{ value: 'fields' as const, label: 'Fields', count: 0 }];
    render(<TabStrip value="fields" items={zeroItems} onChange={() => {}} />);
    const btn = screen.getByText('Fields').closest('button')!;
    expect(btn.textContent).not.toMatch(/\d/);
  });
});
