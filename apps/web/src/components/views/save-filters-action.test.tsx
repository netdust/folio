import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SaveFiltersAction, filtersEqual } from './save-filters-action.tsx';
import type { View } from '../../lib/api/views.ts';
import type { FilterClauseUrl } from '../../lib/api/documents.ts';

function makeView(overrides: Partial<View> = {}): View {
  return {
    id: 'v-1',
    name: 'Triage',
    type: 'list',
    filters: {},
    sort: [],
    groupBy: null,
    visibleFields: null,
    columnOrder: null,
    isDefault: false,
    order: 0,
    ...overrides,
  };
}

interface RenderOpts {
  view: View;
  clauses: FilterClauseUrl[];
}

function renderAction({ view, clauses }: RenderOpts) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SaveFiltersAction wslug="main" pslug="acme" view={view} clauses={clauses} />
    </QueryClientProvider>,
  );
}

function mockFetch() {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (
      String(url).endsWith('/api/v1/w/main/p/acme/views/v-1') &&
      init?.method === 'PATCH'
    ) {
      return new Response(
        JSON.stringify({
          data: {
            id: 'v-1',
            name: 'Triage',
            type: 'list',
            filters: JSON.parse((init.body as string) ?? '{}').filters ?? {},
            sort: [],
            groupBy: null,
            visibleFields: null,
            columnOrder: null,
            isDefault: false,
            order: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function findPatchBody(fetchMock: ReturnType<typeof mockFetch>): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/api/v1/w/main/p/acme/views/v-1') && init?.method === 'PATCH',
  );
  expect(call).toBeDefined();
  return JSON.parse(call![1]!.body as string) as unknown;
}

describe('SaveFiltersAction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders nothing when URL filters match the view filters', () => {
    const view = makeView({ filters: { status: ['In Progress'] } });
    const clauses: FilterClauseUrl[] = [{ kind: 'status', values: ['In Progress'] }];
    renderAction({ view, clauses });
    expect(screen.queryByRole('button', { name: /save filters/i })).not.toBeInTheDocument();
  });

  it('shows the save action when URL filters diverge from the view filters', () => {
    const view = makeView({ filters: {} });
    const clauses: FilterClauseUrl[] = [{ kind: 'status', values: ['Done'] }];
    renderAction({ view, clauses });
    expect(screen.getByRole('button', { name: /save filters/i })).toBeInTheDocument();
  });

  it('confirms and PATCHes view.filters in the flat shape on click', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);

    const view = makeView({ filters: {} });
    const clauses: FilterClauseUrl[] = [{ kind: 'status', values: ['In Progress'] }];
    renderAction({ view, clauses });

    await userEvent.click(screen.getByRole('button', { name: /save filters/i }));

    // Confirm dialog appears with two "Save filters" buttons (chip + confirm);
    // the confirm button lives inside the dialog.
    const dialog = await screen.findByRole('dialog');
    const confirmButton = within(dialog).getByRole('button', { name: /save filters/i });
    await userEvent.click(confirmButton);

    await waitFor(() => {
      const body = findPatchBody(fetchMock);
      expect(body).toEqual({ filters: { status: ['In Progress'] } });
    });
  });

  it('treats AST-shape view filters as equal to flat URL clauses', () => {
    // Seeded default views store `{status: {$eq: 'X'}}`. The action must hide
    // for users on those views when the URL holds the same constraint flat.
    // View has both `type` (view-only key, dropped) and `status` (user filter, coerced to array).
    const astView = makeView({
      filters: { type: { $eq: 'work_item' }, status: { $eq: 'In Progress' } },
    });
    const flatClauses: FilterClauseUrl[] = [{ kind: 'status', values: ['In Progress'] }];

    // Pure function asserts the equality contract.
    // The view's `status` scalar `$eq: 'In Progress'` becomes array `['In Progress']`;
    // the `type` key is dropped. Result equals URL clauses.
    expect(filtersEqual(flatClauses, astView.filters)).toBe(true);

    // Today's UI emits `values: [...]` for status — so the equivalent AST is
    // `$in`. Verify that path equates too.
    const astInView = makeView({ filters: { status: { $in: ['In Progress', 'Done'] } } });
    const inClauses: FilterClauseUrl[] = [
      { kind: 'status', values: ['In Progress', 'Done'] },
    ];
    expect(filtersEqual(inClauses, astInView.filters)).toBe(true);

    // Scalar flat shape should also work.
    const scalarFlatView = makeView({ filters: { status: 'In Progress' } });
    expect(filtersEqual(flatClauses, scalarFlatView.filters)).toBe(true);

    // Unequal: different status value.
    const differentView = makeView({ filters: { status: 'In Progress' } });
    const differentClauses: FilterClauseUrl[] = [{ kind: 'status', values: ['Done'] }];
    expect(filtersEqual(differentClauses, differentView.filters)).toBe(false);
  });

  it('hides the save action on a seeded default view with only type key', () => {
    // Seeded default views store `{type: {$eq: 'work_item'}}`. No user filters.
    // When URL has no clauses, they must be equal (button must not appear).
    const seededDefault = makeView({ filters: { type: { $eq: 'work_item' } } });
    const emptyClauses: FilterClauseUrl[] = [];

    expect(filtersEqual(emptyClauses, seededDefault.filters)).toBe(true);
  });
});
