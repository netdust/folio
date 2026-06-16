import type { GroupedListSettings } from '@folio/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Field } from '../../lib/api/fields.ts';

// Mock useFields: GroupedListConfig is driven by it. We feed a couple of fields
// (one non-multi_select offered for grouping, one multi_select excluded) so the
// group-by exclusion + the field selects render off a known set.
const fields: Field[] = [
  {
    id: 'f1',
    key: 'priority',
    type: 'select',
    label: 'Priority',
    options: ['Low', 'High'],
    required: false,
    order: 1,
  },
  {
    id: 'f2',
    key: 'estimate',
    type: 'number',
    label: 'Estimate',
    options: null,
    required: false,
    order: 2,
  },
  {
    id: 'f3',
    key: 'labels',
    type: 'multi_select',
    label: 'Labels',
    options: ['bug'],
    required: false,
    order: 3,
  },
];

vi.mock('../../lib/api/fields.ts', () => ({
  useFields: () => ({ data: fields }),
}));

// A controlled harness: GroupedListConfig is value/onChange controlled. The
// harness holds the GroupedListSettings so tests can read the assembled shape
// AND drive the controlled re-render (a real consumer = new-view-sheet does the
// same with its own useState).
import { GroupedListConfig, defaultGroupedListSettings } from './grouped-list-config.tsx';

function Harness({ onValue }: { onValue?: (v: GroupedListSettings) => void }) {
  const [value, setValue] = useState<GroupedListSettings>(defaultGroupedListSettings());
  return (
    <GroupedListConfig
      wslug="main"
      pslug="acme"
      tslug="work-items"
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
    />
  );
}

describe('GroupedListConfig', () => {
  it('renders the group-by select with project fields (multi_select excluded) + a status built-in', () => {
    render(<Harness />);
    const groupBy = screen.getByLabelText(/Group by/i);
    // status built-in default.
    expect(within(groupBy).getByRole('option', { name: 'Status' })).toBeInTheDocument();
    // non-multi_select project fields are offered.
    expect(within(groupBy).getByRole('option', { name: 'Priority' })).toBeInTheDocument();
    expect(within(groupBy).getByRole('option', { name: 'Estimate' })).toBeInTheDocument();
    // multi_select is NOT groupable.
    expect(within(groupBy).queryByRole('option', { name: 'Labels' })).toBeNull();
  });

  it('aggregate op select lists EXACTLY the AGGREGATIONS whitelist (sibling-site contract)', () => {
    render(<Harness />);
    // Default: one aggregate row → one op select.
    const opSelect = screen.getByLabelText(/Aggregation 1/i);
    for (const op of ['count', 'pct_matching', 'avg', 'sum', 'distribution']) {
      expect(within(opSelect).getByRole('option', { name: op })).toBeInTheDocument();
    }
    // No extra ops beyond the whitelist (exactly five).
    expect(within(opSelect).getAllByRole('option')).toHaveLength(5);
  });

  it('adds and removes aggregate rows', async () => {
    render(<Harness />);
    // Starts with one row.
    expect(screen.getByLabelText(/Aggregation 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Aggregation 2/i)).toBeNull();
    // Add a row.
    await userEvent.click(screen.getByRole('button', { name: /Add aggregate/i }));
    expect(await screen.findByLabelText(/Aggregation 2/i)).toBeInTheDocument();
    // Remove the second row.
    await userEvent.click(screen.getByRole('button', { name: /Remove aggregate 2/i }));
    expect(screen.queryByLabelText(/Aggregation 2/i)).toBeNull();
  });

  it('reveals a value input when the op is pct_matching', async () => {
    render(<Harness />);
    // No value input for the default count op.
    expect(screen.queryByLabelText(/Match value 1/i)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/Aggregation 1/i), 'pct_matching');
    expect(await screen.findByLabelText(/Match value 1/i)).toBeInTheDocument();
  });

  it('renders the row-layout picker (primary select + a field multi-select)', () => {
    render(<Harness />);
    expect(screen.getByLabelText(/Primary/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Subtitle/i)).toBeInTheDocument();
    // The body-fields multi-select: a checkbox per project field.
    expect(screen.getByRole('checkbox', { name: 'Priority' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Estimate' })).toBeInTheDocument();
  });

  // Tier-A slice: two aggregates → BOTH land in the assembled settings.aggregates.
  it('assembles BOTH aggregates into settings.aggregates (the create-payload shape)', async () => {
    let latest: GroupedListSettings | undefined;
    render(
      <Harness
        onValue={(v) => {
          latest = v;
        }}
      />,
    );

    // Row 1 → avg over the `estimate` field.
    await userEvent.selectOptions(screen.getByLabelText(/Aggregation 1/i), 'avg');
    await userEvent.selectOptions(screen.getByLabelText(/Aggregate field 1/i), 'estimate');

    // Add row 2 → sum over `estimate`.
    await userEvent.click(screen.getByRole('button', { name: /Add aggregate/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/Aggregation 2/i), 'sum');
    await userEvent.selectOptions(screen.getByLabelText(/Aggregate field 2/i), 'estimate');

    expect(latest).toBeDefined();
    expect(latest!.aggregates).toHaveLength(2);
    expect(latest!.aggregates[0]).toMatchObject({ op: 'avg', field: 'estimate' });
    expect(latest!.aggregates[1]).toMatchObject({ op: 'sum', field: 'estimate' });
  });
});
