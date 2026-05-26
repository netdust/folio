import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommentRow } from './comment-row.tsx';
import { commentToMarkdown } from './copy-as-md.ts';
import type { Comment } from '../../lib/api/comments.ts';
import type { Member } from '../../lib/api/members.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = '2026-05-26T10:00:00.000Z';

const baseComment: Comment = {
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
};

const members: Member[] = [
  { id: 'u-1', email: 'stefan@netdust.be', name: 'Stefan V', role: 'owner' },
  { id: 'u-2', email: 'jan@example.com', name: 'Jan Doe', role: 'member' },
];

// ---------------------------------------------------------------------------
// Setup — mock clipboard + freeze Date for relative time
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Freeze time so relativeTime returns predictable "just now"
  vi.setSystemTime(new Date(NOW));
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CommentRow tests
// ---------------------------------------------------------------------------

describe('CommentRow', () => {
  it('renders author as 👤 <member-name> for user author', () => {
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    expect(screen.getByText(/Stefan V/)).toBeInTheDocument();
    expect(screen.getByText(/👤/)).toBeInTheDocument();
  });

  it('renders author as 🤖 <slug> for agent author', () => {
    const agentComment: Comment = {
      ...baseComment,
      frontmatter: { ...baseComment.frontmatter, author: 'agent:drafter' },
    };
    render(
      <CommentRow
        comment={agentComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    expect(screen.getByText(/🤖/)).toBeInTheDocument();
    expect(screen.getByText(/drafter/)).toBeInTheDocument();
  });

  it('renders relative timestamp with absolute ISO in title attribute', () => {
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    const timeEl = screen.getByTitle(NOW);
    expect(timeEl).toBeInTheDocument();
    expect(timeEl.textContent).toBe('just now');
  });

  it('hides kind chip for kind=comment', () => {
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    // There should be no chip with text "comment"
    expect(screen.queryByText('comment')).not.toBeInTheDocument();
  });

  it('renders kind chip with text for kind=plan', () => {
    const planComment: Comment = {
      ...baseComment,
      frontmatter: { ...baseComment.frontmatter, kind: 'plan' },
    };
    render(
      <CommentRow
        comment={planComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    expect(screen.getByText('plan')).toBeInTheDocument();
  });

  it('renders red-tinted error chip + disabled Retry button for kind=error', () => {
    const errorComment: Comment = {
      ...baseComment,
      frontmatter: { ...baseComment.frontmatter, kind: 'error' },
    };
    render(
      <CommentRow
        comment={errorComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    expect(screen.getByText('error')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeDisabled();
    expect(retryBtn).toHaveAttribute('title');
  });

  it('renders run-id badge for agent-written with run_id set', () => {
    const agentComment: Comment = {
      ...baseComment,
      frontmatter: {
        ...baseComment.frontmatter,
        author: 'agent:drafter',
        run_id: 'run-abc12345',
      },
    };
    render(
      <CommentRow
        comment={agentComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    expect(screen.getByText(/run-id:/)).toBeInTheDocument();
    // Short form — first 8 chars of "run-abc12345"
    expect(screen.getByText(/run-abc1/)).toBeInTheDocument();
  });

  it('hides run-id badge for human authors', () => {
    const userComment: Comment = {
      ...baseComment,
      frontmatter: {
        ...baseComment.frontmatter,
        author: 'user:u-1',
        run_id: 'run-abc12345',
      },
    };
    render(
      <CommentRow
        comment={userComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    expect(screen.queryByText(/run-id:/)).not.toBeInTheDocument();
  });

  it('renders body markdown with @-mention chip inline', () => {
    const mentionComment: Comment = {
      ...baseComment,
      body: 'Hello @drafter please help',
      frontmatter: {
        ...baseComment.frontmatter,
        mentions: [{ target: 'drafter', resolved: true }],
      },
    };
    render(
      <CommentRow
        comment={mentionComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    // @drafter should render as a chip
    expect(screen.getByText('@drafter')).toBeInTheDocument();
    // surrounding text
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
    expect(screen.getByText(/please help/)).toBeInTheDocument();
  });

  it('renders body with [[wiki-link]] chip inline', () => {
    const wikiComment: Comment = {
      ...baseComment,
      body: 'See [[my-doc]] for details',
    };
    render(
      <CommentRow
        comment={wikiComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    expect(screen.getByText('my-doc')).toBeInTheDocument();
    expect(screen.getByText(/See/)).toBeInTheDocument();
    expect(screen.getByText(/for details/)).toBeInTheDocument();
  });

  it('renders stale mention with strikethrough when resolved=false', () => {
    const staleComment: Comment = {
      ...baseComment,
      body: 'Ping @old-agent on this',
      frontmatter: {
        ...baseComment.frontmatter,
        mentions: [{ target: 'old-agent', resolved: false }],
      },
    };
    render(
      <CommentRow
        comment={staleComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    const mentionEl = screen.getByText('@old-agent');
    expect(mentionEl).toHaveClass('line-through');
  });

  it('shows Edit + Delete buttons when current user is author (hover group)', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-1"
        workspaceMembers={members}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    // Buttons exist even if not visible (CSS hover-reveal)
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('hides Edit + Delete buttons when current user is NOT author', () => {
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-2"       // different user
        workspaceMembers={members}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('renders soft-deleted row as single muted line with no body', () => {
    const deletedComment: Comment = {
      ...baseComment,
      body: '',
      frontmatter: {
        ...baseComment.frontmatter,
        deleted_at: NOW,
      },
    };
    render(
      <CommentRow
        comment={deletedComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    // Muted deleted line should mention "deleted"
    expect(screen.getByText(/deleted/)).toBeInTheDocument();
    // No body
    expect(screen.queryByText('Hello world')).not.toBeInTheDocument();
    // No hover affordances
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('clicking Copy-as-MD writes commentToMarkdown to clipboard', async () => {
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-1"
        workspaceMembers={members}
      />,
    );
    const copyBtn = screen.getByRole('button', { name: /copy as md/i });
    fireEvent.click(copyBtn);
    // Wait a tick for the async clipboard call
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        commentToMarkdown(baseComment),
      );
    });
  });

  it('clicking Edit calls onEdit(slug)', () => {
    const onEdit = vi.fn();
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-1"
        workspaceMembers={members}
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(baseComment.slug);
  });

  it('clicking Delete calls onDelete(slug)', () => {
    const onDelete = vi.fn();
    render(
      <CommentRow
        comment={baseComment}
        currentUserId="u-1"
        workspaceMembers={members}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledWith(baseComment.slug);
  });
});

// ---------------------------------------------------------------------------
// copy-as-md.ts tests
// ---------------------------------------------------------------------------

describe('commentToMarkdown', () => {
  it('returns YAML frontmatter + body', () => {
    const md = commentToMarkdown(baseComment);
    expect(md).toContain('---');
    expect(md).toContain('author: user:u-1');
    expect(md).toContain('kind: comment');
    expect(md).toContain(`created_at: ${NOW}`);
    expect(md).toContain('Hello world');
  });

  it('omits optional fields when not set', () => {
    const md = commentToMarkdown(baseComment);
    expect(md).not.toContain('visibility:');   // 'normal' is omitted
    expect(md).not.toContain('edited_at:');
    expect(md).not.toContain('target_agent:');
    expect(md).not.toContain('run_id:');
    expect(md).not.toContain('deleted_at:');
  });

  it('includes optional fields when set', () => {
    const richComment: Comment = {
      ...baseComment,
      frontmatter: {
        ...baseComment.frontmatter,
        visibility: 'internal',
        edited_at: '2026-05-26T11:00:00.000Z',
        target_agent: 'drafter',
        run_id: 'run-abc',
        deleted_at: '2026-05-26T12:00:00.000Z',
      },
    };
    const md = commentToMarkdown(richComment);
    expect(md).toContain('visibility: internal');
    expect(md).toContain('edited_at: 2026-05-26T11:00:00.000Z');
    expect(md).toContain('target_agent: drafter');
    expect(md).toContain('run_id: run-abc');
    expect(md).toContain('deleted_at: 2026-05-26T12:00:00.000Z');
  });

  it('handles soft-deleted body (blank)', () => {
    const deleted: Comment = {
      ...baseComment,
      body: '',
      frontmatter: { ...baseComment.frontmatter, deleted_at: NOW },
    };
    const md = commentToMarkdown(deleted);
    expect(md).toContain('deleted_at:');
    // Body section exists but is empty
    const parts = md.split('---\n\n');
    expect(parts[1]).toBe('');
  });
});
