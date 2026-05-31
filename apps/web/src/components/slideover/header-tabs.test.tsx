import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileText, MessageCircle, History } from 'lucide-react';
import { HeaderTabs, type HeaderTabItem } from './header-tabs.tsx';

type T = 'fields' | 'comments' | 'activity';

const items: HeaderTabItem<T>[] = [
  { value: 'fields', label: 'Fields', icon: FileText },
  { value: 'comments', label: 'Comments', icon: MessageCircle, count: 3 },
  { value: 'activity', label: 'Activity', icon: History },
];

describe('HeaderTabs', () => {
  test('renders one icon toggle per tab, each labelled (icon-only — name via aria-label)', () => {
    render(<HeaderTabs value="fields" items={items} onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Fields' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
  });

  test('marks the active tab aria-selected and the rest not', () => {
    render(<HeaderTabs value="comments" items={items} onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking a tab fires onChange(value)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HeaderTabs value="fields" items={items} onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: 'Comments' }));
    expect(onChange).toHaveBeenCalledWith('comments');
  });

  test('clicking the already-active tab does not fire onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<HeaderTabs value="fields" items={items} onChange={onChange} />);
    await user.click(screen.getByRole('tab', { name: 'Fields' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('shows a count badge when count > 0 and hides it at 0/undefined', () => {
    const { rerender } = render(<HeaderTabs value="fields" items={items} onChange={() => {}} />);
    // Comments has count 3 → badge present within the Comments tab.
    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveTextContent('3');
    rerender(
      <HeaderTabs
        value="fields"
        items={[{ value: 'comments', label: 'Comments', icon: MessageCircle, count: 0 }]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Comments' })).not.toHaveTextContent('0');
  });
});
