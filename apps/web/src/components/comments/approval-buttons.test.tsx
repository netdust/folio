import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApprovalButtons } from './approval-buttons.tsx';
import type { Comment } from '../../lib/api/comments.ts';
import type { Member } from '../../lib/api/members.ts';
import { runsKeys } from '../../lib/api/runs.ts';

// ---------------------------------------------------------------------------
// Time anchor — plan was created 5 minutes before NOW
// ---------------------------------------------------------------------------

const NOW = '2026-05-26T10:05:00.000Z';
const PLAN_CREATED = '2026-05-26T10:00:00.000Z';
const RESOLUTION_CREATED = '2026-05-26T10:03:00.000Z'; // 3 min after plan

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const planComment: Comment = {
  id: 'c-plan',
  slug: 'comment-plan',
  type: 'comment',
  title: '',
  parentId: 'doc-1',
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  body: 'Here is my plan',
  frontmatter: {
    author: 'agent:drafter',
    kind: 'plan',
    visibility: 'normal',
    mentions: [],
  },
  createdAt: PLAN_CREATED,
  updatedAt: PLAN_CREATED,
};

const nonPlanComment: Comment = {
  ...planComment,
  id: 'c-nonplan',
  slug: 'comment-nonplan',
  frontmatter: { ...planComment.frontmatter, kind: 'comment' },
};

const humanPlanComment: Comment = {
  ...planComment,
  id: 'c-human-plan',
  slug: 'comment-human-plan',
  frontmatter: { ...planComment.frontmatter, author: 'user:u-1' },
};

const approvalComment: Comment = {
  id: 'c-approval',
  slug: 'comment-approval',
  type: 'comment',
  title: '',
  parentId: 'doc-1',
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  body: 'Approved @drafter',
  frontmatter: {
    author: 'user:u-1',
    kind: 'approval',
    visibility: 'normal',
    mentions: [],
    target_agent: 'drafter',
  },
  createdAt: RESOLUTION_CREATED,
  updatedAt: RESOLUTION_CREATED,
};

const rejectionComment: Comment = {
  ...approvalComment,
  id: 'c-rejection',
  slug: 'comment-rejection',
  body: 'Rejected @drafter',
  frontmatter: {
    ...approvalComment.frontmatter,
    kind: 'rejection',
  },
};

const members: Member[] = [
  { id: 'u-1', email: 'stefan@netdust.be', name: 'Stefan V', role: 'owner' },
  { id: 'u-2', email: 'jan@example.com', name: 'Jan Doe', role: 'member' },
];

// G1/G12 — workspace agent list so the component can resolve agent author
// strings (in either legacy slug or post-F11 id form) back to a slug.
const agents = [{ id: 'ag-drafter-id', slug: 'drafter' }];

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

function stubFetchSuccess() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return new Response(
        JSON.stringify({
          data: {
            id: 'c-new',
            slug: 'comment-new',
            type: 'comment',
            title: '',
            parentId: 'doc-1',
            projectId: 'proj-1',
            workspaceId: 'ws-1',
            body: body.body ?? '',
            frontmatter: {
              author: 'user:u-1',
              kind: body.kind ?? 'comment',
              visibility: 'normal',
              mentions: [],
              ...(body.target_agent ? { target_agent: body.target_agent } : {}),
            },
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

function stubFetchError() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'SERVER_ERROR', message: 'fail' } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

function renderButtons(
  props: Partial<Parameters<typeof ApprovalButtons>[0]> = {},
  qc = makeQC(),
) {
  return render(
    <ApprovalButtons
      planComment={planComment}
      threadComments={[]}
      workspaceSlug="acme"
      projectSlug="proj"
      parentSlug="doc-1"
      workspaceMembers={members}
      workspaceAgents={agents}
      {...props}
    />,
    { wrapper: wrap(qc) },
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  stubFetchSuccess();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalButtons', () => {
  it('renders Approve and Reject buttons for an unresolved plan', () => {
    renderButtons();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('renders null when planComment is not kind=plan', () => {
    const { container } = renderButtons({ planComment: nonPlanComment });
    expect(container.firstChild).toBeNull();
  });

  it('renders null when plan author is not an agent', () => {
    const { container } = renderButtons({ planComment: humanPlanComment });
    expect(container.firstChild).toBeNull();
  });

  it('Approve button POSTs kind=approval with body "Approved @<slug>" and target_agent', async () => {
    renderButtons();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalled();
      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.kind).toBe('approval');
      expect(body.body).toBe('Approved @drafter');
      expect(body.target_agent).toBe('drafter');
    });
  });

  it('Reject opens popover with textarea and Cancel/Reject buttons', () => {
    renderButtons();
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    // The confirm Reject button inside the popover
    const rejectBtns = screen.getAllByRole('button', { name: /reject/i });
    expect(rejectBtns.length).toBeGreaterThanOrEqual(2);
  });

  it('Reject without reason POSTs kind=rejection with body "Rejected @<slug>"', async () => {
    renderButtons();
    // Open the popover
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    // Click the confirm Reject inside popover (last one in DOM)
    const rejectBtns = screen.getAllByRole('button', { name: /reject/i });
    const confirmBtn = rejectBtns[rejectBtns.length - 1];
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalled();
      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.kind).toBe('rejection');
      expect(body.body).toBe('Rejected @drafter');
      expect(body.target_agent).toBe('drafter');
    });
  });

  it('Reject with reason POSTs kind=rejection with body including reason', async () => {
    renderButtons();
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'needs more detail' } });
    const rejectBtns = screen.getAllByRole('button', { name: /reject/i });
    const confirmBtn = rejectBtns[rejectBtns.length - 1];
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock).toHaveBeenCalled();
      const call = fetchMock.mock.calls[0];
      const body = JSON.parse(call[1]?.body as string);
      expect(body.kind).toBe('rejection');
      expect(body.body).toBe('Rejected @drafter: needs more detail');
      expect(body.target_agent).toBe('drafter');
    });
  });

  it('shows "Approved by @<member.name> · 3 minutes later" when approval exists in thread', () => {
    renderButtons({ threadComments: [approvalComment] });
    expect(screen.getByText(/Approved by/)).toBeInTheDocument();
    expect(screen.getByText(/Stefan V/)).toBeInTheDocument();
    expect(screen.getByText(/3 minutes later/)).toBeInTheDocument();
    // Buttons should NOT be present
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('shows "Rejected by @<member.name> · 3 minutes later" when rejection exists', () => {
    renderButtons({ threadComments: [rejectionComment] });
    expect(screen.getByText(/Rejected by/)).toBeInTheDocument();
    expect(screen.getByText(/Stefan V/)).toBeInTheDocument();
    expect(screen.getByText(/3 minutes later/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('picks the earliest matching resolution on multiple', () => {
    const laterApproval: Comment = {
      ...approvalComment,
      id: 'c-approval-late',
      slug: 'comment-approval-late',
      frontmatter: {
        ...approvalComment.frontmatter,
        author: 'user:u-2',
      },
      createdAt: '2026-05-26T10:10:00.000Z',
      updatedAt: '2026-05-26T10:10:00.000Z',
    };
    renderButtons({ threadComments: [laterApproval, approvalComment] });
    // Should pick approvalComment (earliest — 3 min) not laterApproval (10 min)
    expect(screen.getByText(/Stefan V/)).toBeInTheDocument();
    expect(screen.getByText(/3 minutes later/)).toBeInTheDocument();
  });

  it('ignores resolution from a different agent (target_agent mismatch)', () => {
    const wrongTarget: Comment = {
      ...approvalComment,
      frontmatter: {
        ...approvalComment.frontmatter,
        target_agent: 'other-agent',
      },
    };
    renderButtons({ threadComments: [wrongTarget] });
    // Should still show buttons because the approval targets a different agent
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('ignores resolution BEFORE the plan timestamp', () => {
    const beforePlan: Comment = {
      ...approvalComment,
      createdAt: '2026-05-25T10:00:00.000Z', // before PLAN_CREATED
      updatedAt: '2026-05-25T10:00:00.000Z',
    };
    renderButtons({ threadComments: [beforePlan] });
    // Should still show buttons
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  // F9 — a soft-deleted approval/rejection must NOT lock the plan into
  // resolved state. Before this fix, listComments returns deleted rows by
  // design (UI mutes them), but findResolution didn't exclude them, so
  // ApprovalButtons would render "Approved by …" forever even after the user
  // retracted the approval.
  it('F9: ignores soft-deleted approval (does not render resolved state)', () => {
    const deletedApproval: Comment = {
      ...approvalComment,
      frontmatter: {
        ...approvalComment.frontmatter,
        deleted_at: '2026-05-26T10:04:00.000Z',
      },
      body: '', // soft-delete blanks the body
    };
    renderButtons({ threadComments: [deletedApproval] });
    // Should still show Approve/Reject buttons, not the resolved banner.
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(screen.queryByText(/approved by/i)).not.toBeInTheDocument();
  });

  // H11 — REST/MCP clients can persist target_agent as an ID (the schema
  // is bare `z.string()`). findResolution must resolve target_agent
  // through workspaceAgents the same way it resolves the plan author.
  // Before H11: id-form target_agent never matched slug-form agentSlug,
  // leaving plans stuck in unresolved state.
  it('H11: resolves a plan when target_agent is the agent ID (not slug)', () => {
    const idCanonicalPlan: Comment = {
      ...planComment,
      frontmatter: { ...planComment.frontmatter, author: 'agent:ag-drafter-id' },
    };
    const approvalWithIdTarget: Comment = {
      ...approvalComment,
      frontmatter: {
        ...approvalComment.frontmatter,
        target_agent: 'ag-drafter-id', // id instead of slug
      },
    };
    renderButtons({
      planComment: idCanonicalPlan,
      threadComments: [approvalWithIdTarget],
    });
    expect(screen.getByText(/approved by/i)).toBeInTheDocument();
  });

  // G1 — plan author stored as `agent:<id>` (post-F11 canonical form). The
  // server still writes target_agent as the SLUG, so findResolution must
  // resolve id→slug via the workspaceAgents list. Before this fix, the
  // comparison was id vs slug → never matched → plan never resolved.
  it('G1: resolves a plan with id-canonical author against a slug target_agent', () => {
    const idCanonicalPlan: Comment = {
      ...planComment,
      frontmatter: { ...planComment.frontmatter, author: 'agent:ag-drafter-id' },
    };
    renderButtons({ planComment: idCanonicalPlan, threadComments: [approvalComment] });
    expect(screen.getByText(/approved by/i)).toBeInTheDocument();
  });

  // E-6 — when a plan comment is linked to a run via frontmatter.run_id, the
  // Approve/Reject buttons must reflect the LIVE run state: interactive only
  // while the run is awaiting_approval; muted status line once it moves on.
  // Comments without run_id keep the legacy behavior (no fetch, buttons render).

  function stubRunFetch(status: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/runs/')) {
          return new Response(
            JSON.stringify({
              data: {
                id: 'r1',
                slug: 'run-1',
                type: 'agent_run',
                title: 'Run',
                parentId: 'doc-1',
                projectId: 'proj-1',
                workspaceId: 'ws-1',
                status,
                frontmatter: { agent_slug: 'drafter' },
                createdAt: NOW,
                updatedAt: NOW,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // comment-create fallback
        return new Response(JSON.stringify({ data: {} }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }

  const planWithRun: Comment = {
    ...planComment,
    frontmatter: { ...planComment.frontmatter, run_id: 'r1' },
  };

  it('E-6: awaiting_approval run shows interactive Approve/Reject buttons', async () => {
    stubRunFetch('awaiting_approval');
    renderButtons({ planComment: planWithRun });
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('E-6: running run shows muted status line, no buttons', async () => {
    stubRunFetch('running');
    renderButtons({ planComment: planWithRun });
    await waitFor(() => {
      expect(screen.getByText(/approval no longer needed/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('E-6: pre-gate (planning) run does NOT show the muted line — falls through to buttons', () => {
    // Seed the run query cache so `run` is defined synchronously on first
    // render (avoids a fetch-timing race): a planning run has data immediately.
    const qc = makeQC();
    qc.setQueryData(runsKeys.detail('acme', 'r1'), {
      id: 'r1',
      slug: 'run-1',
      type: 'agent_run',
      title: 'Run',
      parentId: 'doc-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      status: 'planning',
      frontmatter: { agent_slug: 'drafter' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    renderButtons({ planComment: planWithRun }, qc);
    // A planning run has not yet reached the awaiting_approval gate, so the
    // "approval no longer needed" muted line must NOT render. The component
    // falls through to the interactive buttons.
    expect(screen.queryByText(/approval no longer needed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('E-6: plan without run_id keeps legacy interactive buttons (no run fetch)', () => {
    renderButtons(); // planComment has no run_id
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('F9: a deleted approval followed by a fresh approval still resolves on the fresh one', () => {
    const deletedApproval: Comment = {
      ...approvalComment,
      id: 'c-deleted-approval',
      slug: 'comment-deleted-approval',
      frontmatter: {
        ...approvalComment.frontmatter,
        deleted_at: '2026-05-26T10:04:00.000Z',
      },
      body: '',
      createdAt: '2026-05-26T10:02:00.000Z', // earlier
    };
    const freshApproval: Comment = {
      ...approvalComment,
      id: 'c-fresh-approval',
      slug: 'comment-fresh-approval',
      createdAt: '2026-05-26T10:04:30.000Z', // later than deleted
    };
    renderButtons({ threadComments: [deletedApproval, freshApproval] });
    expect(screen.getByText(/approved by/i)).toBeInTheDocument();
  });
});
