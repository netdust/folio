import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the conversations API so the cockpit body is testable without a real
// EventSource / server. We capture create + post calls and drive thread state.
const createMutate = vi.fn();
const postMutate = vi.fn();
let conversationState: {
  thread: { id: string; title: string; activeRunId: string | null; messages: unknown[] } | undefined;
  messages: { id: string; kind: string; role: string; body: string; seq: number }[];
  isLoading: boolean;
} = { thread: undefined, messages: [], isLoading: false };

vi.mock('../../lib/api/conversations.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/conversations.ts')>();
  return {
    ...actual,
    useConversation: () => conversationState,
    useCreateConversation: () => ({ mutateAsync: createMutate, isPending: false }),
    usePostMessage: () => ({ mutateAsync: postMutate, isPending: false }),
  };
});

import { CockpitChat } from './cockpit-chat.tsx';

beforeEach(() => {
  createMutate.mockReset();
  postMutate.mockReset();
  createMutate.mockResolvedValue({ id: 'new-conv' });
  postMutate.mockResolvedValue({ runId: 'run-1' });
  conversationState = { thread: undefined, messages: [], isLoading: false };
});

describe('CockpitChat', () => {
  test('empty state: shows the greeting + a Recent chat affordance', () => {
    render(<CockpitChat />);
    // Centered greeting present; the composer is available.
    expect(screen.getByText(/recent chat/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  test('first message with no conversation: creates one, then posts to the new id', async () => {
    const user = userEvent.setup();
    render(<CockpitChat />);
    await user.type(screen.getByRole('textbox'), 'set up a CRM');
    await user.keyboard('{Enter}');
    // Create resolves first, then the post targets the CREATED conversation id
    // (passed as a mutate variable — review #2/#3/#8, no ref/effect bridge).
    expect(createMutate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(postMutate).toHaveBeenCalledWith({ id: 'new-conv', text: 'set up a CRM' }),
    );
  });

  test('optimistically shows the just-sent message (no empty-state flash)', async () => {
    const user = userEvent.setup();
    render(<CockpitChat conversationId="c1" />);
    await user.type(screen.getByRole('textbox'), 'hello there');
    await user.keyboard('{Enter}');
    // The user's text appears immediately, before any seed/live row arrives
    // (review #7). The empty-state greeting is gone.
    expect(await screen.findByText('hello there')).toBeInTheDocument();
    expect(screen.queryByText(/how can the operator help/i)).toBeNull();
  });

  test('a fast double-send does NOT create two conversations (busy guard, review #2)', async () => {
    const user = userEvent.setup();
    // Hold the create open so the second Enter lands while the first is in flight.
    let resolveCreate: (v: { id: string }) => void = () => {};
    createMutate.mockImplementation(
      () => new Promise<{ id: string }>((r) => { resolveCreate = r; }),
    );
    render(<CockpitChat />);
    const box = screen.getByRole('textbox');
    await user.type(box, 'first');
    await user.keyboard('{Enter}');
    await user.type(box, 'second');
    await user.keyboard('{Enter}');
    resolveCreate({ id: 'new-conv' });
    // Only ONE create fired despite two Enters — the second was blocked by busy.
    expect(createMutate).toHaveBeenCalledTimes(1);
  });

  test('renders the thread + blocks the composer while a run is active', () => {
    conversationState = {
      thread: { id: 'c1', title: 'Untitled', activeRunId: 'run-1', messages: [] },
      messages: [
        { id: 'm1', kind: 'text', role: 'user', body: 'do it', seq: 1 },
        { id: 'm2', kind: 'text', role: 'operator', body: 'on it', seq: 2 },
      ],
      isLoading: false,
    };
    render(<CockpitChat conversationId="c1" />);
    expect(screen.getByText('do it')).toBeInTheDocument();
    expect(screen.getByText('on it')).toBeInTheDocument();
    // active run → composer is busy.
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByText(/operator is working/i)).toBeInTheDocument();
  });
});
