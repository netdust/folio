import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TriggerForm } from './trigger-form.tsx';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

// Stub the workspace-documents hook so tests don't need to hit a server.
// `/^event$/i` and `/^schedule$/i` are used where `/event/i` / `/schedule/i`
// would clash with sibling labels like "Event kind" or "Event filters".
vi.mock('../../lib/api/workspace-documents.ts', () => ({
  useWorkspaceAgents: () => ({
    data: [
      { slug: 'drafter', title: 'Drafter' },
      { slug: 'reviewer', title: 'Reviewer' },
    ],
    isLoading: false,
  }),
}));

function Harness(props: { initial?: Record<string, unknown> }) {
  const [v, setV] = useState({
    title: 'My Trigger',
    body: '',
    frontmatter: props.initial ?? {
      schedule: '0 9 * * *',
      on_event: null,
      agent: 'drafter',
      enabled: true,
    },
  });
  return <TriggerForm value={v} onChange={setV} workspaceSlug="acme" />;
}

describe('TriggerForm', () => {
  it('renders mode toggle (schedule + event)', () => {
    render(<Harness />, { wrapper: wrap(newQc()) });
    expect(screen.getByLabelText(/^schedule$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^event$/i)).toBeInTheDocument();
  });

  it('schedule mode renders CronInput', () => {
    render(<Harness />, { wrapper: wrap(newQc()) });
    // CronInput exposes a text input. With the seeded "0 9 * * *" it should render valid.
    expect(screen.getByDisplayValue('0 9 * * *')).toBeInTheDocument();
    expect(screen.getByTestId('cron-valid')).toBeInTheDocument();
  });

  it('switching to event mode clears schedule and shows event dropdown', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: wrap(newQc()) });
    await user.click(screen.getByLabelText(/^event$/i));
    // Event dropdown populated from KNOWN_EVENT_KINDS
    const dd = screen.getByLabelText(/event kind/i) as HTMLSelectElement;
    expect(dd).toBeInTheDocument();
    // Options include known event kinds
    expect(within(dd).getByText('comment.mentioned')).toBeInTheDocument();
    expect(within(dd).getByText('agent.task.assigned')).toBeInTheDocument();
  });

  it('agent dropdown lists workspace agents + custom $event option', () => {
    render(<Harness />, { wrapper: wrap(newQc()) });
    const agentSelect = screen.getByLabelText(/^agent$/i);
    expect(within(agentSelect).getByText('drafter')).toBeInTheDocument();
    expect(within(agentSelect).getByText('reviewer')).toBeInTheDocument();
    expect(within(agentSelect).getByText(/event field/i)).toBeInTheDocument();
  });

  it('typing $event.<key> in the agent custom field updates frontmatter.agent', async () => {
    const onChange = vi.fn();
    render(
      <TriggerForm
        value={{ title: 't', body: '', frontmatter: { schedule: '0 * * * *', agent: null, enabled: true } }}
        onChange={onChange}
        workspaceSlug="acme"
      />,
      { wrapper: wrap(newQc()) },
    );
    const user = userEvent.setup();
    // Switch to "$event field" option
    await user.selectOptions(screen.getByLabelText(/^agent$/i), '__event__');
    // A new text input appears
    const customAgentInput = screen.getByLabelText(/agent.*event.*field/i);
    await user.type(customAgentInput, '$event.assignee_slug');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frontmatter: expect.objectContaining({ agent: '$event.assignee_slug' }),
      }),
    );
  });

  it('payload textarea accepts valid JSON', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerForm
        value={{ title: 't', body: '', frontmatter: { schedule: '0 * * * *', agent: 'drafter', enabled: true, payload: null } }}
        onChange={onChange}
        workspaceSlug="acme"
      />,
      { wrapper: wrap(newQc()) },
    );
    const ta = screen.getByLabelText(/payload/i) as HTMLTextAreaElement;
    await user.clear(ta);
    // user-event v14 reads `{` as the opener of a key-syntax sequence —
    // escape with `{{` to insert a literal brace.
    await user.type(ta, '{{"foo":"bar"}');
    // Last onChange call has parsed payload
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frontmatter: expect.objectContaining({ payload: { foo: 'bar' } }),
      }),
    );
    expect(ta).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('payload textarea shows invalid state on malformed JSON', async () => {
    const user = userEvent.setup();
    render(<Harness />, { wrapper: wrap(newQc()) });
    const ta = screen.getByLabelText(/payload/i) as HTMLTextAreaElement;
    await user.clear(ta);
    // Escape leading `{` for user-event v14.
    await user.type(ta, '{{not json');
    expect(ta).toHaveAttribute('aria-invalid', 'true');
  });

  it('enabled toggle reflects + updates frontmatter.enabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TriggerForm
        value={{ title: 't', body: '', frontmatter: { schedule: '0 * * * *', agent: 'drafter', enabled: true } }}
        onChange={onChange}
        workspaceSlug="acme"
      />,
      { wrapper: wrap(newQc()) },
    );
    const cb = screen.getByLabelText(/enabled/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    await user.click(cb);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frontmatter: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it('builtin: true renders read-only banner + disables every input except enabled', () => {
    render(
      <Harness
        initial={{
          on_event: 'comment.created',
          schedule: null,
          event_filter: { kind: 'approval' },
          agent: null,
          internal_action: 'resume_run',
          enabled: true,
          builtin: true,
        }}
      />,
      { wrapper: wrap(newQc()) },
    );
    expect(screen.getByText(/builtin/i)).toBeInTheDocument();
    // Mode radios disabled
    expect(screen.getByLabelText(/^schedule$/i)).toBeDisabled();
    expect(screen.getByLabelText(/^event$/i)).toBeDisabled();
    // Event dropdown disabled
    expect(screen.getByLabelText(/event kind/i)).toBeDisabled();
    // Enabled toggle still interactive
    expect(screen.getByLabelText(/enabled/i)).not.toBeDisabled();
  });
});
