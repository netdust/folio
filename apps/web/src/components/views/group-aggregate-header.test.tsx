import type { AggregateSpec, GroupSummaryRow } from '@folio/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroupAggregateHeader } from './group-aggregate-header.tsx';

/**
 * GroupAggregateHeader renders the RIGHT side of a grouped-table section header:
 * the scalar aggregate chips + any distribution bar. After the card renderer was
 * deleted (A.2), its ONLY consumer is GroupHeaderRow, which never wants the
 * leading label+count (the LEFT side owns those) — so the dead `showLabelAndCount`
 * / `label` props were removed (simplicity #1). These tests pin the surviving
 * behavior: scalars + distributions render, and no group label/count is emitted.
 */

function row(partial: Partial<GroupSummaryRow> = {}): GroupSummaryRow {
  return { value: 'VAD vzw', count: 5, aggregates: {}, ...partial };
}

describe('GroupAggregateHeader', () => {
  it('renders a scalar aggregate value', () => {
    const aggregates: AggregateSpec[] = [{ op: 'avg', field: 'score' }];
    render(
      <GroupAggregateHeader
        groupKey="VAD vzw"
        row={row({ aggregates: { 'avg:score': 96 } })}
        aggregates={aggregates}
      />,
    );
    expect(screen.getByText(/96/)).toBeInTheDocument();
  });

  it('renders a distribution bar for a distribution aggregate', () => {
    const aggregates: AggregateSpec[] = [{ op: 'distribution', field: 'afgerond' }];
    render(
      <GroupAggregateHeader
        groupKey="VAD vzw"
        row={row({
          aggregates: {
            'distribution:afgerond': [
              { value: 'ja', count: 3 },
              { value: 'nee', count: 2 },
            ],
          },
        })}
        aggregates={aggregates}
      />,
    );
    const bar = screen.getByTestId('distribution-bar');
    expect(bar).toBeInTheDocument();
    expect(bar.querySelectorAll('[data-bucket]').length).toBe(2);
  });

  it('does NOT render the group label or item count (the dead branch is gone)', () => {
    // The only consumer (GroupHeaderRow) owns label+count on its LEFT side. This
    // header must never emit "N items" — that would double the count.
    render(
      <GroupAggregateHeader
        groupKey="VAD vzw"
        row={row({ value: 'VAD vzw', count: 5, aggregates: { 'avg:score': 96 } })}
        aggregates={[{ op: 'avg', field: 'score' }]}
      />,
    );
    expect(screen.queryByText(/items/)).toBeNull();
    expect(screen.queryByText('VAD vzw')).toBeNull();
  });
});
