import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { RelationPicker } from './relation-picker.tsx';

test('lists candidates filtered by target and calls onSelect with slug', async () => {
  const onSelect = vi.fn();
  render(
    <RelationPicker
      candidates={[
        { id: '1', slug: 'people-ada', title: 'Ada' },
        { id: '2', slug: 'people-bob', title: 'Bob' },
      ]}
      query=""
      excludeSlugs={['people-bob']}
      onSelect={onSelect}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText('Ada')).toBeInTheDocument();
  expect(screen.queryByText('Bob')).not.toBeInTheDocument(); // excluded (already linked)
  await userEvent.click(screen.getByText('Ada'));
  expect(onSelect).toHaveBeenCalledWith({ slug: 'people-ada', title: 'Ada' });
});

test('query filters candidates by title (case-insensitive)', () => {
  render(
    <RelationPicker
      candidates={[
        { id: '1', slug: 'a', title: 'Apple' },
        { id: '2', slug: 'b', title: 'Banana' },
      ]}
      query="ban"
      onSelect={vi.fn()}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText('Banana')).toBeInTheDocument();
  expect(screen.queryByText('Apple')).not.toBeInTheDocument();
});
