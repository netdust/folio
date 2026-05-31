import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { BacklinksPanel } from './backlinks-panel.tsx';

test('renders linking docs; empty state when none', () => {
  const { rerender } = render(
    <BacklinksPanel
      backlinks={[
        { id: '1', slug: 'bug-a', title: 'Bug A', type: 'work_item', tableId: 't1' },
      ]}
      onOpen={() => {}}
    />,
  );
  expect(screen.getByText('Bug A')).toBeInTheDocument();
  rerender(<BacklinksPanel backlinks={[]} onOpen={() => {}} />);
  expect(screen.getByText(/no documents link here/i)).toBeInTheDocument();
});
