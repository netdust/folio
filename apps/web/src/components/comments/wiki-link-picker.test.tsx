import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WikiLinkPicker } from './wiki-link-picker.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// The client unwraps the outer { data: T } envelope, so the server returns
// { data: { data: [...rows], nextCursor: null } } but fetch sees the raw JSON.
// The test stub must return the raw server shape so the client can unwrap it.
function makeDocsResponse(docs: ReturnType<typeof makeDoc>[]) {
  return () =>
    new Response(
      JSON.stringify({ data: { data: docs, nextCursor: null } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
}

type DocType = 'page' | 'work_item';

function makeDoc(slug: string, title: string, type: DocType, id = slug) {
  return {
    id,
    slug,
    type,
    title,
    status: null,
    parentId: null,
    frontmatter: {},
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    lastTouchedAt: null,
  };
}

function stubFetch(
  pagesResponse: ReturnType<typeof makeDocsResponse>,
  workItemsResponse: ReturnType<typeof makeDocsResponse>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('type=page')) return pagesResponse();
      if (url.includes('type=work_item')) return workItemsResponse();
      // Fallback — empty list
      return new Response(
        JSON.stringify({ data: { data: [], nextCursor: null } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

const defaultPages = [
  makeDoc('design-system', 'Design System', 'page'),
  makeDoc('api-reference', 'API Reference', 'page'),
];

const defaultWorkItems = [
  makeDoc('fix-login-bug', 'Fix Login Bug', 'work_item'),
  makeDoc('add-dark-mode', 'Add Dark Mode', 'work_item'),
];

describe('WikiLinkPicker', () => {
  it('renders document rows with title visible', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('Design System')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
    expect(screen.getByText('Fix Login Bug')).toBeInTheDocument();
    expect(screen.getByText('Add Dark Mode')).toBeInTheDocument();
  });

  it('shows [[slug]] secondary line for each doc', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('[[design-system]]')).toBeInTheDocument();
    expect(screen.getByText('[[fix-login-bug]]')).toBeInTheDocument();
  });

  it('empty query shows all docs', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    // All 4 docs visible
    expect(await screen.findByText('Design System')).toBeInTheDocument();
    expect(screen.getByText('API Reference')).toBeInTheDocument();
    expect(screen.getByText('Fix Login Bug')).toBeInTheDocument();
    expect(screen.getByText('Add Dark Mode')).toBeInTheDocument();
  });

  it('query filters by title substring (case-insensitive)', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query="design"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('Design System')).toBeInTheDocument();
    expect(screen.queryByText('API Reference')).not.toBeInTheDocument();
    expect(screen.queryByText('Fix Login Bug')).not.toBeInTheDocument();
    expect(screen.queryByText('Add Dark Mode')).not.toBeInTheDocument();
  });

  it('query is case-insensitive', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query="LOGIN"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('Fix Login Bug')).toBeInTheDocument();
    expect(screen.queryByText('Design System')).not.toBeInTheDocument();
    expect(screen.queryByText('Add Dark Mode')).not.toBeInTheDocument();
  });

  it('ArrowDown moves selection to next row', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText('Design System');

    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');

    // Initially index 0 selected
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowUp wraps to last item from first', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText('Design System');

    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');

    // Start at index 0, ArrowUp wraps to last
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    const updated = screen.getAllByRole('option');
    expect(updated[updated.length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowDown wraps to first item from last', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText('Design System');

    const listbox = screen.getByRole('listbox');

    // Move to last (index 3) then ArrowDown wraps to 0
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter selects highlighted row and calls onSelect with { slug, title }', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText('Design System');

    const listbox = screen.getByRole('listbox');

    // Index 0 is selected → Enter selects first page
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith({ slug: 'design-system', title: 'Design System' });
  });

  it('Enter on second row selects correct doc', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText('API Reference');

    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith({ slug: 'api-reference', title: 'API Reference' });
  });

  it('Click on a row calls onSelect with { slug, title }', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    const btn = await screen.findByRole('option', { name: /Fix Login Bug/i });
    fireEvent.click(btn);

    expect(onSelect).toHaveBeenCalledWith({ slug: 'fix-login-bug', title: 'Fix Login Bug' });
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={onClose}
      />,
      { wrapper: wrap(qc) },
    );

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('zero docs in workspace+project → "No documents in this project"', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse([]), makeDocsResponse([]));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('No documents in this project')).toBeInTheDocument();
  });

  it('non-empty docs but filtered to empty → "No matching documents"', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query="zzzzz"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('No matching documents')).toBeInTheDocument();
  });

  it('selection resets to 0 when filtered shape changes', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    const { rerender } = render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText('Design System');

    const listbox = screen.getByRole('listbox');

    // Move to index 2
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');

    // Change query → filtered list shrinks → selection resets to 0
    rerender(
      <QueryClientProvider client={qc}>
        <WikiLinkPicker
          workspaceSlug="acme"
          projectSlug="folio"
          query="design"
          onSelect={onSelect}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // Only 1 doc visible now: "Design System" at index 0
    await screen.findByText('Design System');
    const opts = screen.getAllByRole('option');
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(opts.length).toBe(1);
  });

  it('has role=listbox on container and role=option on rows', async () => {
    const qc = makeQC();
    stubFetch(makeDocsResponse(defaultPages), makeDocsResponse(defaultWorkItems));

    render(
      <WikiLinkPicker
        workspaceSlug="acme"
        projectSlug="folio"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(await screen.findAllByRole('option')).toHaveLength(4);
  });
});
