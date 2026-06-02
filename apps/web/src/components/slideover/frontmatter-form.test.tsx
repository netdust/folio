import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { FrontmatterForm } from './frontmatter-form.tsx';

describe('FrontmatterForm', () => {
  it('renders status as a select (driven by statuses prop) and dispatches frontmatter fields by inferred type', () => {
    render(
      <FrontmatterForm
        type="work_item"
        status="todo"
        statuses={[
          { id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 },
          { id: 's2', key: 'doing', name: 'In progress', color: '#F0A442', category: 'started', order: 2 },
        ]}
        frontmatter={{
          priority: 'high',
          due_date: '2026-06-01',
          urgent: true,
          estimate: 3,
          labels: ['bug', 'fast'],
        }}
        pinnedFields={[]}
        onStatusCommit={() => {}}
        onFrontmatterCommit={() => {}}
      />,
    );
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText('priority')).toBeInTheDocument();
    expect(screen.getByText('due_date')).toBeInTheDocument();
    expect(screen.getByLabelText('urgent')).toBeChecked();
    // estimate is number; rendered as spinbutton
    expect(screen.getByLabelText('estimate')).toBeInTheDocument();
    // labels: chips
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText('fast')).toBeInTheDocument();
  });

  it('hides status field when type=page', () => {
    render(
      <FrontmatterForm
        type="page"
        status={null}
        statuses={[]}
        frontmatter={{ priority: 'low' }}
        pinnedFields={[]}
        onStatusCommit={() => {}}
        onFrontmatterCommit={() => {}}
      />,
    );
    expect(screen.queryByText('status')).not.toBeInTheDocument();
    expect(screen.getByText('priority')).toBeInTheDocument();
  });

  it('committing a field calls onFrontmatterCommit with just that key', async () => {
    const onCommit = vi.fn();
    render(
      <FrontmatterForm
        type="work_item"
        status={null}
        statuses={[]}
        frontmatter={{ priority: 'low' }}
        pinnedFields={[]}
        onStatusCommit={() => {}}
        onFrontmatterCommit={onCommit}
      />,
    );
    await userEvent.click(screen.getByText('low'));
    const input = screen.getByRole('textbox', { name: 'priority' });
    await userEvent.clear(input);
    await userEvent.type(input, 'high{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ priority: 'high' });
  });

  it('does not surface system_prompt as a curated agent field (prompt is the body now)', () => {
    render(
      <FrontmatterForm
        type="agent"
        status={null}
        statuses={[]}
        // A stale doc may still carry a system_prompt key. The curated
        // AGENT_FIELDS entry (with its descriptive help text) must be gone, so
        // the field no longer reads as a first-class prompt surface. No
        // `provider`/`projects` keys here — those mount sub-editors needing a
        // QueryClient; `max_tokens_per_run` renders plainly via FieldRenderer.
        frontmatter={{ system_prompt: 'old', max_tokens_per_run: 100000 }}
        pinnedFields={[]}
        onStatusCommit={() => {}}
        onFrontmatterCommit={() => {}}
      />,
    );
    // The curated description that accompanied the removed AGENT_FIELDS entry
    // must not render — that text was the only thing marking system_prompt as
    // the prompt surface.
    expect(
      screen.queryByText(/Instructions the agent receives on every run/i),
    ).toBeNull();
    // sanity: the form did render its curated fields.
    expect(screen.getByText('max_tokens_per_run')).toBeInTheDocument();
  });

  it('renders a TriggerAgentField for a trigger\'s agent key, committing the bare slug', async () => {
    const stub = () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'op', slug: 'operator', type: 'agent', title: 'Operator',
              status: null, parentId: null, library: true, frontmatter: { projects: ['*'] },
              createdAt: '', updatedAt: '', lastTouchedAt: null,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    vi.stubGlobal('fetch', vi.fn(async () => stub()));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCommit = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <FrontmatterForm
          wslug="acme"
          pslug=""
          type="trigger"
          status={null}
          statuses={[]}
          frontmatter={{ agent: '' }}
          pinnedFields={[]}
          onStatusCommit={() => {}}
          onFrontmatterCommit={onCommit}
        />
      </QueryClientProvider>,
    );
    // Not a plain text input — opening the picker reveals the agent and commits
    // the BARE slug (not `agent:operator`).
    await userEvent.click(screen.getByRole('button', { name: /pick an agent/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Operator/i }));
    expect(onCommit).toHaveBeenCalledWith({ agent: 'operator' });
    vi.unstubAllGlobals();
  });

  it('a pinned field type overrides inference', () => {
    render(
      <FrontmatterForm
        type="work_item"
        status={null}
        statuses={[]}
        frontmatter={{ category: 'one' }} // would infer string
        pinnedFields={[
          { id: 'f1', key: 'category', type: 'select', label: 'Category', options: ['one', 'two', 'three'], required: false, order: 0 },
        ]}
        onStatusCommit={() => {}}
        onFrontmatterCommit={() => {}}
      />,
    );
    expect(screen.getByText('Category')).toBeInTheDocument();
    // Select renders display as a popover trigger button; clicking opens a listbox.
    // Just check the option exists in DOM after open.
  });
});
