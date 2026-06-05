import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// --- Router mock: capture navigate calls (link_panel) -----------------------
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// --- useButtonClick mock: capture the choice-card mutation (M8) --------------
const clickMutate = vi.fn();
let clickState: { isPending: boolean; isSuccess: boolean; variables?: { optionId: string } } = {
  isPending: false,
  isSuccess: false,
};
vi.mock('../../lib/api/conversations.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/conversations.ts')>();
  return {
    ...actual,
    useButtonClick: () => ({ mutate: clickMutate, ...clickState }),
  };
});

import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { MessageText } from './message-text.tsx';
import { MessageToolStep } from './message-tool-step.tsx';
import { MessageLinkPanel } from './message-link-panel.tsx';
import { MessageChoiceCard } from './message-choice-card.tsx';
import { entityRoute } from './entity-route.ts';

function msg(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    role: 'operator',
    kind: 'text',
    body: '',
    payload: null,
    runId: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  navigateMock.mockReset();
  clickMutate.mockReset();
  clickState = { isPending: false, isSuccess: false };
});

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------
describe('MessageText', () => {
  test('renders user and operator text', () => {
    const { rerender } = render(<MessageText message={msg({ role: 'user', kind: 'text', body: 'hello' })} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    rerender(<MessageText message={msg({ role: 'operator', kind: 'text', body: 'done' })} />);
    expect(screen.getByText('done')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// tool_step
// ---------------------------------------------------------------------------
describe('MessageToolStep', () => {
  test('renders the tool + summary', () => {
    render(
      <MessageToolStep
        message={msg({
          kind: 'tool_step',
          payload: JSON.stringify({ tool: 'create_document', summary: 'Created Acme', status: 'ok' }),
        })}
      />,
    );
    expect(screen.getByText('create_document')).toBeInTheDocument();
    expect(screen.getByText('Created Acme')).toBeInTheDocument();
  });

  test('an error step is marked with an error status label', () => {
    render(
      <MessageToolStep
        message={msg({
          kind: 'tool_step',
          payload: JSON.stringify({ tool: 'delete_x', summary: 'failed', status: 'error' }),
        })}
      />,
    );
    expect(screen.getByLabelText('status: error')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// entityRoute (the single resolver)
// ---------------------------------------------------------------------------
describe('entityRoute', () => {
  test('document-shaped targets open the workspace slideover via wdoc', () => {
    expect(
      entityRoute({ entityType: 'document', entityId: 'onboard-acme', wslug: 'acme' }),
    ).toEqual({ to: '/w/$wslug', params: { wslug: 'acme' }, search: { wdoc: 'onboard-acme' } });
  });
  test('agent targets route to the agents surface', () => {
    expect(entityRoute({ entityType: 'agent', entityId: 'op', wslug: 'acme' })).toEqual({
      to: '/w/$wslug/agents',
      params: { wslug: 'acme' },
      search: { wdoc: 'op' },
    });
  });
});

// ---------------------------------------------------------------------------
// link_panel — click NAVIGATES, cockpit stays open
// ---------------------------------------------------------------------------
describe('MessageLinkPanel', () => {
  test('clicking navigates to the resolved entity route (cockpit stays open)', async () => {
    const user = userEvent.setup();
    render(
      <MessageLinkPanel
        message={msg({
          kind: 'component',
          payload: JSON.stringify({
            type: 'link_panel',
            target: { entityType: 'document', entityId: 'onboard-acme', wslug: 'acme' },
            title: 'Onboard Acme',
          }),
        })}
      />,
    );
    await user.click(screen.getByText('Onboard Acme'));
    // Navigates the main area to the resolved route. The cockpit is a
    // layout-level panel, NOT a modal — this navigation does not close it (the
    // panel component is unaffected; only the router destination changes).
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(
      entityRoute({ entityType: 'document', entityId: 'onboard-acme', wslug: 'acme' }),
    );
  });

  // Cluster-5 /code-review fix: a malformed/incomplete target (here: missing
  // `wslug`) must NOT render a clickable card that would navigate to /w/undefined.
  // The tolerant-render contract — one bad row degrades to nothing, never breaks
  // the thread or navigates broken. Bites: against the old `if (!target) return`
  // this renders a card whose click navigates with wslug:undefined.
  test('a link_panel with an incomplete target renders nothing (no broken nav)', () => {
    const { container } = render(
      <MessageLinkPanel
        message={msg({
          kind: 'component',
          payload: JSON.stringify({
            type: 'link_panel',
            target: { entityType: 'document', entityId: 'x' }, // no wslug
            title: 'Broken',
          }),
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Broken')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// choice_card — sends option ID (M8), locks on chosen
// ---------------------------------------------------------------------------
describe('MessageChoiceCard', () => {
  const card = msg({
    id: 'card-1',
    kind: 'component',
    payload: JSON.stringify({
      type: 'choice_card',
      prompt: 'Which template?',
      options: [
        { id: 'leads', label: 'Leads CRM' },
        { id: 'support', label: 'Support desk' },
      ],
    }),
  });

  test('M8 — clicking sends the option ID, not the label', async () => {
    const user = userEvent.setup();
    render(<MessageChoiceCard message={card} conversationId="c1" />);
    await user.click(screen.getByText('Leads CRM'));
    expect(clickMutate).toHaveBeenCalledTimes(1);
    expect(clickMutate).toHaveBeenCalledWith({ messageId: 'card-1', optionId: 'leads' });
    // The label ('Leads CRM') must NEVER be the wire value.
    expect(clickMutate.mock.calls[0]![0].optionId).not.toBe('Leads CRM');
  });

  test('locks to the chosen option (others disabled) when payload.chosen is set', () => {
    const chosen = msg({
      id: 'card-1',
      kind: 'component',
      payload: JSON.stringify({
        type: 'choice_card',
        prompt: 'Which template?',
        options: [
          { id: 'leads', label: 'Leads CRM' },
          { id: 'support', label: 'Support desk' },
        ],
        chosen: 'leads',
      }),
    });
    render(<MessageChoiceCard message={chosen} conversationId="c1" />);
    const leads = screen.getByText('Leads CRM').closest('button')!;
    const support = screen.getByText('Support desk').closest('button')!;
    // Both disabled once locked; the chosen one is pressed.
    expect(leads).toBeDisabled();
    expect(support).toBeDisabled();
    expect(leads).toHaveAttribute('aria-pressed', 'true');
    expect(support).toHaveAttribute('aria-pressed', 'false');
  });
});
