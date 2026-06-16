import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Mock the four data hooks the renderer reads (per the task contract — mirrors
// kanban-view.test.tsx, but mocking the hooks directly rather than fetch so the
// summary-vs-page header contract is expressible cleanly).
import * as documentsApi from '../../lib/api/documents.ts';
import * as fieldsApi from '../../lib/api/fields.ts';
import * as groupSummaryApi from '../../lib/api/group-summary.ts';
import * as useActiveViewApi from '../../lib/api/use-active-view.ts';
import { GroupedListView } from './grouped-list-view.tsx';

vi.mock('../../lib/api/group-summary.ts', async (orig) => {
  const actual = await orig<typeof import('../../lib/api/group-summary.ts')>();
  return { ...actual, useGroupSummary: vi.fn() };
});
vi.mock('../../lib/api/documents.ts', async (orig) => {
  const actual = await orig<typeof import('../../lib/api/documents.ts')>();
  return { ...actual, useInfiniteDocuments: vi.fn() };
});
vi.mock('../../lib/api/use-active-view.ts', async (orig) => {
  const actual = await orig<typeof import('../../lib/api/use-active-view.ts')>();
  return { ...actual, useActiveView: vi.fn() };
});
vi.mock('../../lib/api/fields.ts', async (orig) => {
  const actual = await orig<typeof import('../../lib/api/fields.ts')>();
  return { ...actual, useFields: vi.fn() };
});

const mockGroupSummary = vi.mocked(groupSummaryApi.useGroupSummary);
const mockDocuments = vi.mocked(documentsApi.useInfiniteDocuments);
const mockActiveView = vi.mocked(useActiveViewApi.useActiveView);
const mockFields = vi.mocked(fieldsApi.useFields);

type DocRow = {
  id: string;
  slug: string;
  type: 'work_item';
  title: string;
  status: string | null;
  parentId: null;
  frontmatter: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function doc(partial: Partial<DocRow> & { id: string; slug: string; title: string }): DocRow {
  return {
    type: 'work_item',
    status: null,
    parentId: null,
    frontmatter: {},
    createdAt: '',
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

// Minimal query-result stand-in: the renderer only reads `.data`, `.isLoading`,
// `.error` off these hooks.
// biome-ignore lint/suspicious/noExplicitAny: test stub for a react-query result shape
function summaryResult(data: unknown, over: Record<string, unknown> = {}): any {
  return { data, isLoading: false, error: null, ...over };
}

/**
 * useInfiniteDocuments stand-in. The renderer reads `data.pages.flatMap(p =>
 * p.data)` for the rows, plus `hasNextPage`/`fetchNextPage`/`isFetchingNextPage`
 * for the "Load more" control. Pass one or more page-data arrays; each becomes a
 * `{ data, nextCursor }` page. `hasNextPage` defaults to false (single page).
 */
// biome-ignore lint/suspicious/noExplicitAny: test stub for a react-infinite-query result shape
function infiniteResult(pages: DocRow[][], over: Record<string, unknown> = {}): any {
  return {
    data: {
      pages: pages.map((rows, i) => ({
        data: rows,
        nextCursor: i < pages.length - 1 ? `cursor-${i}` : null,
      })),
    },
    isLoading: false,
    error: null,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    ...over,
  };
}

// Plain query-result stand-in for the FIELDS hook (reads `.data` directly).
// biome-ignore lint/suspicious/noExplicitAny: test stub for a react-query result shape
function fieldsResult(data: unknown, over: Record<string, unknown> = {}): any {
  return { data, isLoading: false, error: null, ...over };
}

// Back-compat shim for the existing single-page tests: wrap one page's `data`
// array (the old `{ data: [...], nextCursor }` shape) into the infinite result.
// biome-ignore lint/suspicious/noExplicitAny: test stub for a react-infinite-query result shape
function docsResult(data: unknown, over: Record<string, unknown> = {}): any {
  if (data === undefined) {
    return {
      data: undefined,
      isLoading: false,
      error: null,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
      ...over,
    };
  }
  const page = data as { data: DocRow[]; nextCursor?: string | null };
  return infiniteResult([page.data], {
    hasNextPage: page.nextCursor != null,
    ...over,
  });
}

function activeViewWith(settings: Record<string, unknown> | undefined) {
  return {
    view: settings
      ? ({
          id: 'v1',
          name: 'Grouped',
          type: 'list',
          filters: {},
          sort: null,
          groupBy: null,
          visibleFields: null,
          columnOrder: null,
          settings,
          isDefault: true,
          order: 1,
          // biome-ignore lint/suspicious/noExplicitAny: minimal View stub for the test
        } as any)
      : undefined,
    views: [],
    isLoading: false,
  };
}

function setup() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/grouped',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = route.useParams();
      return <GroupedListView wslug={wslug} pslug={pslug} tslug="work-items" />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/grouped'] }),
  });
  return { router };
}

function renderView() {
  const { router } = setup();
  render(<RouterProvider router={router} />);
  return { router };
}

const DEFAULT_SETTINGS = {
  groupBy: 'status',
  aggregates: [{ op: 'count' }],
  rowLayout: { primary: 'title', fields: [] },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('GroupedListView', () => {
  it('renders one group section per summary group with its value, item count, and a configured aggregate', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [
          { value: 'todo', count: 3, aggregates: { count: 3 } },
          { value: 'doing', count: 2, aggregates: { count: 2 } },
        ],
        ungrouped: null,
        truncated: false,
      }),
    );
    mockDocuments.mockReturnValue(
      docsResult({
        data: [
          doc({ id: 'd1', slug: 'a', title: 'Card A', status: 'todo' }),
          doc({ id: 'd2', slug: 'b', title: 'Card B', status: 'doing' }),
        ],
        nextCursor: null,
      }),
    );

    renderView();

    const todoHeader = await screen.findByTestId('group-header-todo');
    expect(todoHeader).toHaveTextContent('todo');
    expect(todoHeader).toHaveTextContent('3');
    expect(screen.getByTestId('group-header-doing')).toHaveTextContent('2');
  });

  it('THE page-2 guard: header total comes from the summary endpoint, NOT a client count of loaded rows', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    // The endpoint says this group has 148 docs (the FULL set)...
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [{ value: 'done', count: 148, aggregates: { count: 148 } }],
        ungrouped: null,
        truncated: false,
      }),
    );
    // ...but only 5 rows are loaded on this page.
    mockDocuments.mockReturnValue(
      docsResult({
        data: Array.from({ length: 5 }, (_, i) =>
          doc({ id: `d${i}`, slug: `s${i}`, title: `Row ${i}`, status: 'done' }),
        ),
        nextCursor: 'next',
      }),
    );

    renderView();

    const header = await screen.findByTestId('group-header-done');
    // The header MUST show 148 (endpoint full-set), never 5 (loaded-row count).
    expect(header).toHaveTextContent('148');
    expect(header).not.toHaveTextContent(/\b5\b/);
  });

  it('renders a distribution bar for a distribution aggregate', async () => {
    mockActiveView.mockReturnValue(
      activeViewWith({
        groupBy: 'status',
        aggregates: [{ op: 'distribution', field: 'priority' }],
        rowLayout: { primary: 'title', fields: [] },
      }),
    );
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [
          {
            value: 'todo',
            count: 4,
            aggregates: {
              'distribution:priority': [
                { value: 'high', count: 3 },
                { value: 'low', count: 1 },
              ],
            },
          },
        ],
        ungrouped: null,
        truncated: false,
      }),
    );
    mockDocuments.mockReturnValue(
      docsResult({
        data: [doc({ id: 'd1', slug: 'a', title: 'Card A', status: 'todo' })],
        nextCursor: null,
      }),
    );

    renderView();

    const bar = await screen.findByTestId('distribution-bar');
    expect(bar).toBeInTheDocument();
    // Each bucket renders a segment.
    expect(bar.querySelectorAll('[data-bucket]').length).toBe(2);
  });

  it('renders composed rich-rows from the paginated documents (primary + rowLayout fields)', async () => {
    mockActiveView.mockReturnValue(
      activeViewWith({
        groupBy: 'status',
        aggregates: [{ op: 'count' }],
        rowLayout: { primary: 'title', subtitle: 'assignee', fields: ['priority'] },
      }),
    );
    mockFields.mockReturnValue(
      fieldsResult([
        {
          id: 'f1',
          key: 'priority',
          type: 'select',
          label: 'Priority',
          options: ['High', 'Low'],
          required: false,
          order: 1,
        },
        {
          id: 'f2',
          key: 'assignee',
          type: 'string',
          label: 'Assignee',
          options: null,
          required: false,
          order: 2,
        },
      ]),
    );
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [{ value: 'todo', count: 1, aggregates: { count: 1 } }],
        ungrouped: null,
        truncated: false,
      }),
    );
    mockDocuments.mockReturnValue(
      docsResult({
        data: [
          doc({
            id: 'd1',
            slug: 'a',
            title: 'Card A',
            status: 'todo',
            frontmatter: { priority: 'High', assignee: 'Stefan' },
          }),
        ],
        nextCursor: null,
      }),
    );

    renderView();

    const row = await screen.findByTestId('grouped-row-a');
    expect(row).toHaveTextContent('Card A'); // primary
    expect(row).toHaveTextContent('Stefan'); // subtitle
    expect(row).toHaveTextContent('High'); // rowLayout field
  });

  it('renders the no-group bucket LAST when ungrouped is non-null', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [{ value: 'todo', count: 1, aggregates: { count: 1 } }],
        ungrouped: { value: null, count: 2, aggregates: { count: 2 } },
        truncated: false,
      }),
    );
    mockDocuments.mockReturnValue(
      docsResult({
        data: [
          doc({ id: 'd1', slug: 'a', title: 'Grouped', status: 'todo' }),
          doc({ id: 'd2', slug: 'b', title: 'Loose One', status: null }),
        ],
        nextCursor: null,
      }),
    );

    renderView();

    const nogroup = await screen.findByTestId('group-header-__nogroup__');
    expect(nogroup).toBeInTheDocument();
    expect(nogroup).toHaveTextContent('2');
    // The no-group section must appear AFTER the real group in DOM order.
    const all = screen.getAllByTestId(/^group-header-/);
    expect(all[all.length - 1]).toBe(nogroup);
    // The status-less row lands in the no-group bucket.
    expect(screen.getByTestId('grouped-row-b')).toBeInTheDocument();
  });

  it('shows EmptyState when there are 0 documents', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({ groups: [], ungrouped: null, truncated: false }),
    );
    mockDocuments.mockReturnValue(docsResult({ data: [], nextCursor: null }));

    renderView();

    expect(await screen.findByText('No work items')).toBeInTheDocument();
    // No empty group shells.
    expect(screen.queryAllByTestId(/^group-header-/).length).toBe(0);
  });

  it('clicking a row navigates with ?doc=<slug>', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [{ value: 'todo', count: 1, aggregates: { count: 1 } }],
        ungrouped: null,
        truncated: false,
      }),
    );
    mockDocuments.mockReturnValue(
      docsResult({
        data: [doc({ id: 'd1', slug: 'a', title: 'Card A', status: 'todo' })],
        nextCursor: null,
      }),
    );

    const { router } = renderView();
    await userEvent.click(await screen.findByText('Card A'));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'a' }));
  });

  it('shows a "+N more groups" affordance when truncated', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [{ value: 'todo', count: 1, aggregates: { count: 1 } }],
        ungrouped: null,
        truncated: true,
      }),
    );
    mockDocuments.mockReturnValue(
      docsResult({
        data: [doc({ id: 'd1', slug: 'a', title: 'Card A', status: 'todo' })],
        nextCursor: null,
      }),
    );

    renderView();

    expect(await screen.findByText(/more groups/i)).toBeInTheDocument();
  });

  it('renders a skeleton while loading', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(summaryResult(undefined, { isLoading: true }));
    mockDocuments.mockReturnValue(docsResult(undefined, { isLoading: true }));

    renderView();

    expect(await screen.findByTestId('grouped-list-skeleton')).toBeInTheDocument();
  });

  it('pager total = sum of all group counts + ungrouped count (the full set, not the page)', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [
          { value: 'todo', count: 100, aggregates: { count: 100 } },
          { value: 'done', count: 147, aggregates: { count: 147 } },
        ],
        ungrouped: { value: null, count: 0, aggregates: { count: 0 } },
        truncated: false,
      }),
    );
    mockDocuments.mockReturnValue(
      docsResult({
        data: Array.from({ length: 10 }, (_, i) =>
          doc({ id: `d${i}`, slug: `s${i}`, title: `Row ${i}`, status: 'todo' }),
        ),
        nextCursor: 'next',
      }),
    );

    renderView();

    // 100 + 147 + 0 = 247 — from the summary, never the 10 loaded rows.
    expect(await screen.findByTestId('grouped-list-pager')).toHaveTextContent('247');
  });

  // FIX I-3: rows past page 1 must be reachable via infinite pagination.
  it('renders rows from EVERY loaded page (not just page 1) and shows a "Load more" button when hasNextPage', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [
          { value: 'todo', count: 1, aggregates: { count: 1 } },
          { value: 'done', count: 1, aggregates: { count: 1 } },
        ],
        ungrouped: null,
        truncated: false,
      }),
    );
    const fetchNextPage = vi.fn();
    // Two loaded pages: page-1 has a 'todo' row, page-2 has a 'done' row. With the
    // OLD single-page useDocuments, the page-2 row would never render.
    mockDocuments.mockReturnValue(
      infiniteResult(
        [
          [doc({ id: 'd1', slug: 'page1', title: 'Page-1 Row', status: 'todo' })],
          [doc({ id: 'd2', slug: 'page2', title: 'Page-2 Row', status: 'done' })],
        ],
        { hasNextPage: true, fetchNextPage },
      ),
    );

    renderView();

    // BOTH pages' rows render — the page-2 row is reachable.
    expect(await screen.findByTestId('grouped-row-page1')).toBeInTheDocument();
    expect(screen.getByTestId('grouped-row-page2')).toBeInTheDocument();

    // The "Load more" button is present and clicking it fetches the next page.
    const loadMore = screen.getByTestId('grouped-list-load-more');
    await userEvent.click(loadMore);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('hides the "Load more" button when there is no next page', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    mockGroupSummary.mockReturnValue(
      summaryResult({
        groups: [{ value: 'todo', count: 1, aggregates: { count: 1 } }],
        ungrouped: null,
        truncated: false,
      }),
    );
    mockDocuments.mockReturnValue(
      infiniteResult([[doc({ id: 'd1', slug: 'a', title: 'Card A', status: 'todo' })]], {
        hasNextPage: false,
      }),
    );

    renderView();

    await screen.findByTestId('grouped-row-a');
    expect(screen.queryByTestId('grouped-list-load-more')).toBeNull();
  });

  // FIX I-1: a failing group-summary must surface an error, NOT a silent empty view.
  it('surfaces an error affordance when the group-summary query fails (not a silent empty state)', async () => {
    mockActiveView.mockReturnValue(activeViewWith(DEFAULT_SETTINGS));
    mockFields.mockReturnValue(fieldsResult([]));
    // The summary call failed → no group data. With the OLD code this rendered an
    // empty "0 van 0" view with NO error affordance.
    mockGroupSummary.mockReturnValue(
      summaryResult(undefined, { error: new Error('boom'), isError: true }),
    );
    // Rows DID load — they should still render alongside the summary-error banner.
    mockDocuments.mockReturnValue(
      infiniteResult([[doc({ id: 'd1', slug: 'a', title: 'Card A', status: 'todo' })]]),
    );

    renderView();

    // The error affordance is shown (NOT a silent empty state).
    expect(await screen.findByText(/groepssamenvatting niet laden/i)).toBeInTheDocument();
    // And it is NOT the EmptyState.
    expect(screen.queryByText('No work items')).toBeNull();
  });
});
