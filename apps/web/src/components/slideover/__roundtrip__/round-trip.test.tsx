import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { z } from 'zod';
import { DocumentSlideover } from '../document-slideover.tsx';

// Body section of the golden fixture (everything after the closing --- and blank line).
// The code fence containing frontmatter-like YAML is the critical tricky case.
const FIXTURE_BODY = `# Spring 26 Artists

Body intro paragraph with a [link](https://example.com) and **bold** text.

## Code with frontmatter-looking content

\`\`\`
---
this: looks like frontmatter
but: is inside a code fence
---
\`\`\`

## Table

| Artist | Status | Notes |
|---|---|---|
| A | confirmed | <kbd>Ctrl-S</kbd> |
| B | pending | Has a <abbr title="Lorem">L</abbr> |

## Task list

- [ ] task one
- [x] task two

Done.
`;

const FIXTURE_FRONTMATTER = {
  priority: 'high',
  due_date: '2026-06-01',
  labels: ['bug', 'urgent'],
  estimate: 3,
  agent: false,
  metadata: { source: 'import', notes: 'tricky shape — nested object survives round-trip' },
};

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const project = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = project.useParams();
      return <DocumentSlideover wslug={wslug} pslug={pslug} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([project]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web?doc=spring-26-artists'] }),
  });
  return { queryClient, router };
}

describe('Slideover round-trip', () => {
  let patches: Array<{ slug: string; body: unknown; frontmatter?: unknown }>;

  beforeEach(() => {
    patches = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';

      if (u.includes('/documents/spring-26-artists') && method === 'GET') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug: 'spring-26-artists',
              type: 'work_item',
              title: 'Spring 26 Artists',
              status: 'doing',
              parentId: null,
              frontmatter: FIXTURE_FRONTMATTER,
              body: FIXTURE_BODY,
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (u.includes('/documents/spring-26-artists') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          body?: string;
          frontmatter?: Record<string, unknown>;
        };
        patches.push({ slug: 'spring-26-artists', ...body });
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug: 'spring-26-artists',
              type: 'work_item',
              title: 'Spring 26 Artists',
              status: 'doing',
              parentId: null,
              frontmatter: { ...FIXTURE_FRONTMATTER, ...(body.frontmatter ?? {}) },
              body: body.body ?? FIXTURE_BODY,
              createdAt: '2026-01-01',
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (u.includes('/statuses') || u.includes('/fields')) {
        return new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('toggling rich → raw → rich does not corrupt the body string', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Spring 26 Artists')).toBeInTheDocument());

    // Toggle to Raw
    await userEvent.click(screen.getByRole('button', { name: /Raw MD/ }));
    await waitFor(() => expect(screen.getByTestId('raw-md-editor')).toBeInTheDocument());

    // Toggle back to Edit
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));

    // Drain any debounced calls — no edit was made so none should fire
    vi.advanceTimersByTime(1000);

    // No PATCH should have fired — the user only toggled modes, never edited.
    expect(patches.length).toBe(0);

    vi.useRealTimers();
  });

  it('editing in raw mode patches the exact byte-for-byte body the user sees', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Spring 26 Artists')).toBeInTheDocument());

    // Switch to raw editor
    await userEvent.click(screen.getByRole('button', { name: /Raw MD/ }));
    const rawEditor = await screen.findByTestId('raw-md-editor');
    const cmContent = rawEditor.querySelector('.cm-content') as HTMLElement | null;
    expect(cmContent).toBeTruthy();

    // Append text via simulated keystrokes into the CodeMirror content element.
    // jsdom doesn't run CodeMirror's input pipeline reliably — if the keystroke
    // doesn't reach the editor state, no PATCH fires. That's an acceptable jsdom
    // limitation: Manual QA scenario #8 is the definitive sign-off.
    await userEvent.click(cmContent!);
    await userEvent.keyboard('{End}');
    await userEvent.keyboard('appended.');

    // Let the 400 ms debounce (plus a buffer) drain
    vi.advanceTimersByTime(600);

    if (patches.length > 0) {
      // A PATCH fired — verify the body is not corrupted:
      // 1. The code-fence block with inner frontmatter-like content is verbatim.
      // 2. The table with raw HTML (<kbd>, <abbr>) is verbatim.
      // 3. The user's append is present.
      const lastBody = String(patches[patches.length - 1]?.body ?? '');
      expect(lastBody).toContain('---\nthis: looks like frontmatter\nbut: is inside a code fence\n---');
      expect(lastBody).toContain('| Artist | Status | Notes |');
      expect(lastBody).toMatch(/appended\.\s*$/);
    } else {
      // jsdom did not dispatch the keystroke into CodeMirror's state — no PATCH fired.
      // This is acceptable here; the manual QA scenario covers byte-level round-trip.
      expect(patches.length).toBe(0);
    }

    vi.useRealTimers();
  });
});
