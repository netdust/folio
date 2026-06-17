import type { AggregateSpec, GroupSummaryRow } from '@folio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GroupHeaderRow } from './group-header-row.tsx';

/**
 * GroupHeaderRow is the full-width section header for the grouped-TABLE list
 * view (Phase 6, Task A.1). It owns the LEFT side (chevron + field-name prefix +
 * group value + full-set count) and reuses GroupAggregateHeader for the RIGHT
 * side (scalar stats + distribution bar). Every number comes from `row` (the
 * group-summary endpoint), never a client count of loaded rows.
 */

function row(partial: Partial<GroupSummaryRow> = {}): GroupSummaryRow {
  return { value: 'VAD vzw', count: 5, aggregates: {}, ...partial };
}

describe('GroupHeaderRow', () => {
  it('renders the field-name prefix, the group value label, and the full-set count', () => {
    render(
      <GroupHeaderRow
        label="VAD vzw"
        groupBy="organisatie"
        row={row({ value: 'VAD vzw', count: 5 })}
        aggregates={[{ op: 'count' }]}
        collapsed={false}
        onToggle={() => {}}
      />,
    );

    // The uppercase field-name prefix (the groupBy), the group value, and the count.
    expect(screen.getByText(/ORGANISATIE/i)).toBeInTheDocument();
    expect(screen.getByText('VAD vzw')).toBeInTheDocument();
    expect(screen.getByText(/\b5\b/)).toBeInTheDocument();
  });

  it('renders a configured scalar aggregate value', () => {
    const aggregates: AggregateSpec[] = [{ op: 'avg', field: 'score' }];
    render(
      <GroupHeaderRow
        label="VAD vzw"
        groupBy="organisatie"
        row={row({ aggregates: { 'avg:score': 96 } })}
        aggregates={aggregates}
        collapsed={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText(/96/)).toBeInTheDocument();
  });

  it('renders the distribution bar when a distribution aggregate is configured', () => {
    const aggregates: AggregateSpec[] = [{ op: 'distribution', field: 'afgerond' }];
    render(
      <GroupHeaderRow
        label="VAD vzw"
        groupBy="organisatie"
        row={row({
          aggregates: {
            'distribution:afgerond': [
              { value: 'ja', count: 3 },
              { value: 'nee', count: 2 },
            ],
          },
        })}
        aggregates={aggregates}
        collapsed={false}
        onToggle={() => {}}
      />,
    );

    const bar = screen.getByTestId('distribution-bar');
    expect(bar).toBeInTheDocument();
    expect(bar.querySelectorAll('[data-bucket]').length).toBe(2);
  });

  it('clicking the chevron fires onToggle', async () => {
    const onToggle = vi.fn();
    render(
      <GroupHeaderRow
        label="VAD vzw"
        groupBy="organisatie"
        row={row()}
        aggregates={[{ op: 'count' }]}
        collapsed={false}
        onToggle={onToggle}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /collapse|expand|toggle/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('the chevron direction reflects the collapsed prop', () => {
    const { rerender } = render(
      <GroupHeaderRow
        label="VAD vzw"
        groupBy="organisatie"
        row={row()}
        aggregates={[{ op: 'count' }]}
        collapsed={false}
        onToggle={() => {}}
      />,
    );
    const expandedBtn = screen.getByRole('button', { name: /collapse|expand|toggle/i });
    expect(expandedBtn).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <GroupHeaderRow
        label="VAD vzw"
        groupBy="organisatie"
        row={row()}
        aggregates={[{ op: 'count' }]}
        collapsed={true}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /collapse|expand|toggle/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  // THE Tier-A slice (the page-2 guard, preserved): the count shown is
  // row.count (the endpoint full-set value), NEVER a count of loaded rows.
  it('shows row.count (the endpoint full-set), never a loaded-row count', () => {
    render(
      <GroupHeaderRow
        label="Afgerond"
        groupBy="status"
        // The endpoint says this group has 148 docs (the FULL set).
        row={row({ value: 'Afgerond', count: 148, aggregates: { count: 148 } })}
        aggregates={[{ op: 'count' }]}
        collapsed={false}
        onToggle={() => {}}
      />,
    );

    // The header MUST show 148 — the full-set value from the endpoint.
    expect(screen.getByText(/\b148\b/)).toBeInTheDocument();
  });
});
