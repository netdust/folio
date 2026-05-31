import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { RelationCell } from './relation-cell.tsx';

test('renders linked titles as chips, unresolved slug struck-through', () => {
  render(
    <RelationCell
      value={['[[people-ada]]', '[[ghost]]']}
      resolve={(slug) => (slug === 'people-ada' ? { slug, title: 'Ada' } : null)}
    />,
  );
  expect(screen.getByText('Ada')).toBeInTheDocument();
  const ghost = screen.getByText('[[ghost]]');
  expect(ghost).toHaveClass('line-through');
});

test('empty value renders a dash', () => {
  render(<RelationCell value={undefined} resolve={() => null} />);
  expect(screen.getByText('—')).toBeInTheDocument();
});
