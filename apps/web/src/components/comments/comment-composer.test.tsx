import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CommentComposer } from './comment-composer.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

beforeEach(() => {
  localStorage.clear();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function stubFetchEmpty() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function renderComposer(overrides: Partial<React.ComponentProps<typeof CommentComposer>> = {}) {
  const onSubmit = vi.fn(async () => {});
  const onCollapse = vi.fn();
  const qc = makeQC();
  stubFetchEmpty();
  const utils = render(
    <CommentComposer
      workspaceSlug="acme"
      projectSlug="proj"
      projectId="pid-1"
      parentId="task-42"
      onSubmit={onSubmit}
      onCollapse={onCollapse}
      {...overrides}
    />,
    { wrapper: wrap(qc) },
  );
  return { ...utils, onSubmit, onCollapse, qc };
}

describe('CommentComposer', () => {
  it('renders editor wrapper, Comment submit button, and Cancel button', () => {
    renderComposer();
    expect(screen.getByTestId('comment-composer')).toBeInTheDocument();
    expect(screen.getByTestId('comment-composer-submit')).toBeInTheDocument();
    expect(screen.getByTestId('comment-composer-cancel')).toBeInTheDocument();
  });

  it('shows the Cmd+Enter hint on the Comment submit button', () => {
    renderComposer();
    const submit = screen.getByTestId('comment-composer-submit');
    expect(submit.textContent).toMatch(/Comment/);
    // The hint glyph is rendered as ⌘↵ — assert via the rendered character.
    expect(submit.textContent).toMatch(/⌘↵/);
  });

  it('submit button is disabled when body is empty', () => {
    renderComposer();
    const submit = screen.getByTestId('comment-composer-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('loads saved draft from localStorage on mount and enables submit', () => {
    localStorage.setItem('folio:comment-draft:task-42', 'hello from draft');
    renderComposer();
    const submit = screen.getByTestId('comment-composer-submit') as HTMLButtonElement;
    // Initial draft populates body state synchronously → submit enabled immediately.
    expect(submit.disabled).toBe(false);
  });

  it('clicking Cancel calls onCollapse and clears the localStorage draft', () => {
    localStorage.setItem('folio:comment-draft:task-42', 'leftover');
    const { onCollapse } = renderComposer();
    fireEvent.click(screen.getByTestId('comment-composer-cancel'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('folio:comment-draft:task-42')).toBeNull();
  });

  it('Escape on empty composer calls onCollapse', () => {
    const { onCollapse } = renderComposer();
    fireEvent.keyDown(screen.getByTestId('comment-composer'), { key: 'Escape' });
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('Escape on non-empty composer does NOT call onCollapse', () => {
    localStorage.setItem('folio:comment-draft:task-42', 'has content');
    const { onCollapse } = renderComposer();
    fireEvent.keyDown(screen.getByTestId('comment-composer'), { key: 'Escape' });
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it('Cmd+Enter triggers onSubmit with the current body and clears the draft', async () => {
    localStorage.setItem('folio:comment-draft:task-42', 'ship it');
    const { onSubmit } = renderComposer();
    fireEvent.keyDown(screen.getByTestId('comment-composer'), {
      key: 'Enter',
      metaKey: true,
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('ship it');
    // Draft cleared on success.
    await waitFor(() => {
      expect(localStorage.getItem('folio:comment-draft:task-42')).toBeNull();
    });
  });

  it('Ctrl+Enter also triggers onSubmit (Windows/Linux)', async () => {
    localStorage.setItem('folio:comment-draft:task-42', 'linux-submit');
    const { onSubmit } = renderComposer();
    fireEvent.keyDown(screen.getByTestId('comment-composer'), {
      key: 'Enter',
      ctrlKey: true,
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith('linux-submit');
  });

  it('Cmd+Enter does NOT submit when body is empty', () => {
    const { onSubmit } = renderComposer();
    fireEvent.keyDown(screen.getByTestId('comment-composer'), {
      key: 'Enter',
      metaKey: true,
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Cmd+Enter does NOT submit when body is only whitespace', () => {
    localStorage.setItem('folio:comment-draft:task-42', '   \n   ');
    const { onSubmit } = renderComposer();
    fireEvent.keyDown(screen.getByTestId('comment-composer'), {
      key: 'Enter',
      metaKey: true,
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Submit button click calls onSubmit and clears localStorage draft', async () => {
    localStorage.setItem('folio:comment-draft:task-42', 'via click');
    const { onSubmit } = renderComposer();
    fireEvent.click(screen.getByTestId('comment-composer-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('via click'));
    await waitFor(() =>
      expect(localStorage.getItem('folio:comment-draft:task-42')).toBeNull(),
    );
  });

  it('keeps body intact if onSubmit rejects (no draft clear on failure)', async () => {
    localStorage.setItem('folio:comment-draft:task-42', 'will fail');
    const onSubmit = vi.fn(async () => {
      throw new Error('network');
    });
    const qc = makeQC();
    stubFetchEmpty();
    render(
      <CommentComposer
        workspaceSlug="acme"
        projectSlug="proj"
        projectId="pid-1"
        parentId="task-42"
        onSubmit={onSubmit}
        onCollapse={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );
    fireEvent.keyDown(screen.getByTestId('comment-composer'), {
      key: 'Enter',
      metaKey: true,
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // Failure: draft is NOT cleared.
    expect(localStorage.getItem('folio:comment-draft:task-42')).toBe('will fail');
  });

  it('does not call onSubmit twice while the first call is still pending', async () => {
    localStorage.setItem('folio:comment-draft:task-42', 'guard');
    let resolveSubmit: (() => void) | null = null;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const qc = makeQC();
    stubFetchEmpty();
    render(
      <CommentComposer
        workspaceSlug="acme"
        projectSlug="proj"
        projectId="pid-1"
        parentId="task-42"
        onSubmit={onSubmit}
        onCollapse={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );
    fireEvent.keyDown(screen.getByTestId('comment-composer'), {
      key: 'Enter',
      metaKey: true,
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Trigger again while pending.
    fireEvent.keyDown(screen.getByTestId('comment-composer'), {
      key: 'Enter',
      metaKey: true,
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Resolve to clean up.
    act(() => resolveSubmit?.());
  });

  // --- Tests deferred to Playwright (C11) ---
  // The following behaviors require the Milkdown ProseMirror DOM, which jsdom
  // cannot render with block-level structure. Exercised via Playwright in C11.

  it.skip('TODO C11 Playwright: typing `@` opens MentionPicker positioned at caret', () => {
    // Requires real ProseMirror input events + range.getBoundingClientRect.
  });

  it.skip('TODO C11 Playwright: typing `[[` opens WikiLinkPicker positioned at caret', () => {
    // Requires real ProseMirror input events.
  });

  it.skip('TODO C11 Playwright: selecting an agent replaces `@drafter` with `@drafter `', () => {
    // Requires real editor content + cursor positioning.
  });

  it.skip('TODO C11 Playwright: selecting a wiki target replaces `[[task` with `[[task-slug]] `', () => {
    // Requires real editor content.
  });

  it.skip('TODO C11 Playwright: debounced draft save fires 300ms after editor change', () => {
    // Requires real Milkdown markdownUpdated event to fire on input.
  });
});
