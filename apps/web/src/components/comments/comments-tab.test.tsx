import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CommentsTab } from './comments-tab.tsx';
import type { Comment } from '../../lib/api/comments.ts';
import type { Member } from '../../lib/api/members.ts';
import type { StreamedEvent, EventStreamFilters } from '../../lib/api/event-stream.ts';

// ---------------------------------------------------------------------------
// Module-level mock for useEventStream.
// vi.mock is hoisted to the top of the file regardless of where it appears in
// source, so we declare it here at module scope alongside a spy ref the SSE
// tests can inspect without interfering with other tests (the default no-op
// means all existing tests continue to pass unchanged).
// ---------------------------------------------------------------------------

const mockUseEventStream = vi.fn<
  [string, EventStreamFilters, (e: StreamedEvent) => void],
  void
>();

vi.mock('../../lib/api/event-stream.ts', () => ({
  useEventStream: (
    wslug: string,
    filters: EventStreamFilters,
    onEvent: (e: StreamedEvent) => void,
  ) => mockUseEventStream(wslug, filters, onEvent),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-05-26T10:00:00.000Z';
const OLDER = '2026-05-26T09:00:00.000Z';

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c-1',
    slug: 'comment-c-1',
    type: 'comment',
    title: '',
    parentId: 'doc-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    body: 'Hello world',
    frontmatter: {
      author: 'user:u-1',
      kind: 'comment',
      visibility: 'normal',
      mentions: [],
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const members: Member[] = [
  { id: 'u-1', email: 'stefan@netdust.be', name: 'Stefan V', role: 'owner' },
];

const defaultProps = {
  workspaceSlug: 'acme',
  workspaceId: 'ws-1',
  projectSlug: 'proj',
  projectId: 'proj-1',
  parentSlug: 'doc-1',
  parentId: 'doc-1',
  currentUserId: 'u-1',
  currentAgentSlug: null,
  workspaceMembers: members,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubFetchList(comments: Comment[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (urlIn: string | URL, init?: RequestInit) => {
      const url = typeof urlIn === 'string' ? urlIn : urlIn.toString();
      const method = init?.method?.toUpperCase() ?? 'GET';
      if (method === 'GET') {
        // G1/G2: CommentsTab fetches workspace agents to resolve id-canonical
        // author strings. Return a baseline 'drafter' agent so plan rows
        // (`author: 'agent:drafter'`) resolve through authorAgentSlug post-H17
        // (the heuristic phantom-slug fallback was removed).
        if (url.includes('?type=agent') || url.includes('&type=agent')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'agent-drafter-id',
                  slug: 'drafter',
                  type: 'agent',
                  title: 'Drafter',
                  parentId: null,
                  projectId: null,
                  workspaceId: 'ws-1',
                  frontmatter: {},
                  body: '',
                  status: null,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ data: comments }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // POST / PATCH / DELETE — return a stub comment
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const stubComment = makeComment({ body: body.body ?? 'updated' });
      return new Response(
        JSON.stringify({ data: stubComment }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

function renderTab(
  props: Partial<typeof defaultProps> = {},
  qc = makeQC(),
) {
  return render(
    <CommentsTab {...defaultProps} {...props} />,
    { wrapper: wrap(qc) },
  );
}

// ---------------------------------------------------------------------------
// Setup — no fake timers (waitFor uses real setTimeout internally)
// ---------------------------------------------------------------------------

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no-op
  }
  stubFetchList([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    // no-op
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommentsTab', () => {
  it('renders the composer at top + visibility toggle + count + list', async () => {
    stubFetchList([makeComment()]);
    renderTab();
    // Composer should be present immediately (static)
    expect(screen.getByTestId('comment-composer')).toBeInTheDocument();
    // Visibility toggle present immediately
    expect(screen.getByRole('button', { name: /show internal/i })).toBeInTheDocument();
    // Wait for async query to load and show count
    await waitFor(() => {
      expect(screen.getByText(/💬 1 comments/)).toBeInTheDocument();
    });
  });

  it('shows newest-first ordering', async () => {
    const newer = makeComment({ id: 'c-2', slug: 'c-newer', body: 'Newer comment', createdAt: NOW });
    const older = makeComment({ id: 'c-1', slug: 'c-older', body: 'Older comment', createdAt: OLDER });
    // Server returns oldest first; component must sort newest-first
    stubFetchList([older, newer]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText('Newer comment')).toBeInTheDocument();
      expect(screen.getByText('Older comment')).toBeInTheDocument();
    });
    // Newer should appear before older in the DOM
    const newerEl = screen.getByText('Newer comment');
    const olderEl = screen.getByText('Older comment');
    expect(
      newerEl.compareDocumentPosition(olderEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('count reflects data length', async () => {
    const comments = [
      makeComment({ id: 'c-1', slug: 'c-1' }),
      makeComment({ id: 'c-2', slug: 'c-2', body: 'Second' }),
      makeComment({ id: 'c-3', slug: 'c-3', body: 'Third' }),
      makeComment({ id: 'c-4', slug: 'c-4', body: 'Fourth' }),
    ];
    stubFetchList(comments);
    renderTab();
    await waitFor(() => {
      expect(screen.getByText(/💬 4 comments/)).toBeInTheDocument();
    });
  });

  it('renders ApprovalButtons on kind=plan rows', async () => {
    const planComment = makeComment({
      id: 'c-plan',
      slug: 'c-plan',
      body: 'Here is my plan',
      frontmatter: {
        author: 'agent:drafter',
        kind: 'plan',
        visibility: 'normal',
        mentions: [],
      },
    });
    stubFetchList([planComment]);
    renderTab();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    });
  });

  it('visibility toggle defaults to off (visibility=[normal])', () => {
    renderTab();
    const toggle = screen.getByRole('button', { name: /show internal/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggling visibility refetches with [normal, internal]', async () => {
    renderTab();
    const toggle = screen.getByRole('button', { name: /show internal/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // The hook will re-fetch with the new visibility — URL should include 'internal'
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const calls = fetchMock.mock.calls;
      const hasInternalFetch = calls.some(([url]) =>
        typeof url === 'string' && url.includes('internal'),
      );
      expect(hasInternalFetch).toBe(true);
    });
  });

  it('visibility state persists in localStorage keyed by workspaceId', () => {
    renderTab();
    const toggle = screen.getByRole('button', { name: /show internal/i });
    fireEvent.click(toggle);
    const stored = localStorage.getItem('folio:comments-show-internal:ws-1');
    expect(stored).toBe('true');
  });

  it('visibility state restores from localStorage on mount', () => {
    localStorage.setItem('folio:comments-show-internal:ws-1', 'true');
    renderTab();
    const toggle = screen.getByRole('button', { name: /show internal/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking Edit switches the row to inline edit mode', async () => {
    const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'Original body' });
    stubFetchList([comment]);
    renderTab();
    await waitFor(() => screen.getByText('Original body'));

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByTestId('inline-edit-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('inline-edit-save')).toBeInTheDocument();
    expect(screen.getByTestId('inline-edit-cancel')).toBeInTheDocument();
  });

  it('saving inline edit calls useUpdateComment with new body', async () => {
    const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'Original body' });
    stubFetchList([comment]);
    renderTab();
    await waitFor(() => screen.getByText('Original body'));

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    const textarea = screen.getByTestId('inline-edit-textarea');
    fireEvent.change(textarea, { target: { value: 'Updated body' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('inline-edit-save'));
    });

    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const patchCall = fetchMock.mock.calls.find(([_url, init]) =>
        (init as RequestInit)?.method?.toUpperCase() === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.body).toBe('Updated body');
    });
  });

  it('cancel inline edit reverts without saving', async () => {
    const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'Original body' });
    stubFetchList([comment]);
    renderTab();
    await waitFor(() => screen.getByText('Original body'));

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    const textarea = screen.getByTestId('inline-edit-textarea');
    fireEvent.change(textarea, { target: { value: 'Changed but cancelled' } });
    fireEvent.click(screen.getByTestId('inline-edit-cancel'));

    // Inline editor should be gone
    expect(screen.queryByTestId('inline-edit-textarea')).not.toBeInTheDocument();
    // No PATCH issued
    const fetchMock = vi.mocked(fetch);
    const patchCalls = fetchMock.mock.calls.filter(([_url, init]) =>
      (init as RequestInit)?.method?.toUpperCase() === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
  });

  it('clicking Delete opens confirm dialog', async () => {
    const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'To be deleted' });
    stubFetchList([comment]);
    renderTab();
    await waitFor(() => screen.getByText('To be deleted'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-confirm-btn')).toBeInTheDocument();
    expect(screen.getByTestId('delete-cancel-btn')).toBeInTheDocument();
  });

  it('confirming delete calls useDeleteComment', async () => {
    const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'To be deleted' });
    stubFetchList([comment]);
    renderTab();
    await waitFor(() => screen.getByText('To be deleted'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => screen.getByRole('dialog'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-confirm-btn'));
    });

    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const deleteCall = fetchMock.mock.calls.find(([_url, init]) =>
        (init as RequestInit)?.method?.toUpperCase() === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
    });
  });

  // ---------- Retry wiring (error comment → useRetryRun) --------------
  it('clicking Retry on an error comment POSTs to the run retry endpoint with the run id', async () => {
    const errorComment = makeComment({
      id: 'c-err',
      slug: 'comment-c-err',
      body: 'Run blew up',
      frontmatter: {
        author: 'agent:drafter',
        kind: 'error',
        visibility: 'normal',
        mentions: [],
        run_id: 'run-fail9999',
      },
    });
    stubFetchList([errorComment]);
    renderTab();
    await waitFor(() => screen.getByText('Run blew up'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    });

    // Seam: assert the un-mocked client→react-query→useRetryRun chain hit the
    // real wire — a POST to /runs/<runId>/retry. No mock of the hook itself.
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const retryCall = fetchMock.mock.calls.find(([url, init]) => {
        const u = typeof url === 'string' ? url : (url as URL).toString();
        return (
          (init as RequestInit)?.method?.toUpperCase() === 'POST' &&
          u.includes('/runs/run-fail9999/retry')
        );
      });
      expect(retryCall).toBeDefined();
    });
  });

  it('error comment WITHOUT a run_id renders no Retry button and fires no retry POST', async () => {
    const errorComment = makeComment({
      id: 'c-err2',
      slug: 'comment-c-err2',
      body: 'No run to retry',
      frontmatter: {
        author: 'agent:drafter',
        kind: 'error',
        visibility: 'normal',
        mentions: [],
      },
    });
    stubFetchList([errorComment]);
    renderTab();
    await waitFor(() => screen.getByText('No run to retry'));

    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    const retryCall = vi.mocked(fetch).mock.calls.find(([url]) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      return u.includes('/retry');
    });
    expect(retryCall).toBeUndefined();
  });

  // BUG-017 — handleSaveEdit / handleDeleteConfirm closed the editor/dialog
  // in `finally`, unconditionally. On PATCH/DELETE failure, the optimistic
  // rollback restored the original body, the editor was gone, and the user's
  // typed correction was lost with no way to retry except re-typing.
  // Fix: close on success only; keep editor/dialog open on error so the user
  // sees the toast + can retry.
  describe('BUG-017 — keep editor/dialog open on failed mutation', () => {
    function stubFetchListWithFailingPatch(comments: Comment[]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (urlIn: string | URL, init?: RequestInit) => {
          const url = typeof urlIn === 'string' ? urlIn : urlIn.toString();
          const method = init?.method?.toUpperCase() ?? 'GET';
          if (method === 'GET') {
            if (url.includes('?type=agent') || url.includes('&type=agent')) {
              return new Response(
                JSON.stringify({ data: [] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            }
            return new Response(
              JSON.stringify({ data: comments }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          // PATCH/DELETE: return a 422 to trigger the mutation's error branch.
          if (method === 'PATCH' || method === 'DELETE') {
            return new Response(
              JSON.stringify({ error: { code: 'BODY_TOO_LARGE', message: 'too big' } }),
              { status: 422, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response('{}', { status: 200 });
        }),
      );
    }

    it('saving inline edit keeps the editor open + user text intact when PATCH fails', async () => {
      const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'Original body' });
      stubFetchListWithFailingPatch([comment]);
      renderTab();
      await waitFor(() => screen.getByText('Original body'));

      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      const textarea = screen.getByTestId('inline-edit-textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'My long correction' } });

      await act(async () => {
        fireEvent.click(screen.getByTestId('inline-edit-save'));
      });

      // After the failed PATCH, the editor stays open (BUG-017 — was closing
      // unconditionally in finally) AND retains the user's typed value.
      await waitFor(() => {
        expect(screen.getByTestId('inline-edit-textarea')).toBeInTheDocument();
      });
      expect(
        (screen.getByTestId('inline-edit-textarea') as HTMLTextAreaElement).value,
      ).toBe('My long correction');
    });

    it('confirming delete keeps the dialog open when DELETE fails', async () => {
      const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'To be deleted' });
      stubFetchListWithFailingPatch([comment]);
      renderTab();
      await waitFor(() => screen.getByText('To be deleted'));

      fireEvent.click(screen.getByRole('button', { name: /delete/i }));
      await waitFor(() => screen.getByRole('dialog'));

      await act(async () => {
        fireEvent.click(screen.getByTestId('delete-confirm-btn'));
      });

      // After the failed DELETE, the dialog stays open so the user can retry.
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(screen.getByTestId('delete-confirm-btn')).toBeInTheDocument();
    });
  });

  it('canceling delete dialog does not call mutation', async () => {
    const comment = makeComment({ id: 'c-1', slug: 'comment-c-1', body: 'To be deleted' });
    stubFetchList([comment]);
    renderTab();
    await waitFor(() => screen.getByText('To be deleted'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => screen.getByRole('dialog'));

    fireEvent.click(screen.getByTestId('delete-cancel-btn'));

    // No DELETE call
    const fetchMock = vi.mocked(fetch);
    const deleteCalls = fetchMock.mock.calls.filter(([_url, init]) =>
      (init as RequestInit)?.method?.toUpperCase() === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('Load more button renders when data.length >= 50', async () => {
    const comments = Array.from({ length: 50 }, (_, i) =>
      makeComment({ id: `c-${i}`, slug: `c-${i}`, body: `Comment ${i}` }),
    );
    stubFetchList(comments);
    renderTab();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
    });
  });

  it('Load more button hidden when data.length < 50', async () => {
    stubFetchList([makeComment()]);
    renderTab();
    await waitFor(() => screen.getByText('Hello world'));
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  // F15 — composer must remount when parentId changes so the debounced
  // draft writer (built once via useRef in CommentComposer) doesn't keep
  // writing the new doc's text into the OLD doc's localStorage key.
  //
  // We assert via the load-draft side-effect: when parentId changes from
  // 'doc-A' to 'doc-B' AND localStorage already has a draft for B,
  // re-rendering with the new parentId must load B's draft (which only
  // happens on mount). Without key={parentId}, the composer stays mounted
  // with A's stale `initialDraft` closure and the submit button stays
  // disabled.
  it('F15: composer remounts when parentId changes, reloading the correct draft', async () => {
    localStorage.setItem('folio:comment-draft:doc-B', 'leftover for B');
    // H21: drive BOTH parentId AND parentSlug to fresh values, mirroring
    // real document navigation. The previous version held parentSlug
    // constant and only swapped parentId — a regression that switched
    // `key={parentId}` to `key={parentSlug}` would still have passed,
    // masking the bug F15 closed.
    const { rerender } = renderTab({ parentId: 'doc-A', parentSlug: 'a' });
    // doc-A has no draft → submit disabled.
    const submitA = screen.getByTestId('comment-composer-submit') as HTMLButtonElement;
    expect(submitA.disabled).toBe(true);

    // Switch to doc-B without unmounting the slideover. The composer must
    // remount (keyed on parentId) and read doc-B's draft.
    rerender(<CommentsTab {...defaultProps} parentId="doc-B" parentSlug="b" />);
    const submitB = screen.getByTestId('comment-composer-submit') as HTMLButtonElement;
    expect(submitB.disabled).toBe(false);
  });

  // SSE live-update — CommentsTab must subscribe to comment.created +
  // comment.deleted events filtered by parentId (NOT parentSlug), and must
  // invalidate the comments list query (keyed on parentSlug) on receipt.
  describe('SSE live-update', () => {
    beforeEach(() => {
      mockUseEventStream.mockReset();
    });

    it('subscribes with parent:parentId + correct kinds, invalidates list on event', async () => {
      // Capture the filters + callback passed to useEventStream on the first call.
      let capturedFilters: EventStreamFilters | undefined;
      let capturedOnEvent: ((e: StreamedEvent) => void) | undefined;

      mockUseEventStream.mockImplementation((_wslug, filters, onEvent) => {
        capturedFilters = filters;
        capturedOnEvent = onEvent;
      });

      const qc = makeQC();
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      renderTab(
        {
          workspaceSlug: 'acme',
          projectSlug: 'web',
          parentSlug: 'wi-1',
          parentId: 'pid-1',
        },
        qc,
      );

      // The hook must have been called with parent=parentId (not parentSlug)
      // and exactly the two dotted event kinds.
      expect(capturedFilters).toMatchObject({
        parent: 'pid-1',
        kinds: ['comment.created', 'comment.deleted'],
      });

      // Firing the SSE callback must invalidate the list query keyed on
      // parentSlug (not parentId).
      capturedOnEvent!({ id: 'e-1', kind: 'comment.created' });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['comments', 'acme', 'web', 'wi-1', 'list'],
      });
    });
  });
});
