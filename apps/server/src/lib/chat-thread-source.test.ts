import { describe, expect, test } from 'bun:test';
import { rowsToMessages, skillsToMessages } from './chat-thread-source.ts';
import type { Message as MessageRow } from '../db/schema.ts';

// Minimal row factory — only the fields rowsToMessages reads.
function row(partial: Partial<MessageRow> & Pick<MessageRow, 'role' | 'kind'>): MessageRow {
  return {
    id: 'm',
    conversationId: 'c',
    seq: 0,
    body: '',
    payload: null,
    runId: null,
    createdAt: new Date(0),
    ...partial,
  } as MessageRow;
}

describe('rowsToMessages — roles MUST alternate (Anthropic 400 guard)', () => {
  // The exact shape that bit the confirm-resume path: one user turn, then a
  // single operator turn that emitted several tool_steps + a component card.
  // All the operator rows map to `assistant`; without coalescing the provider
  // sees user, assistant, assistant, … and 400s with "roles must alternate".
  test('coalesces consecutive operator rows into ONE assistant message', () => {
    const out = rowsToMessages([
      row({ role: 'user', kind: 'text', body: 'remove the board view' }),
      row({ role: 'operator', kind: 'tool_step', payload: JSON.stringify({ tool: 'list_views', summary: 'ok', status: 'ok' }) }),
      row({ role: 'operator', kind: 'tool_step', payload: JSON.stringify({ tool: 'folio_api', summary: 'ok', status: 'ok' }) }),
      row({ role: 'operator', kind: 'component', payload: JSON.stringify({ type: 'choice_card', prompt: 'Confirm?', chosen: undefined }) }),
      row({ role: 'operator', kind: 'text', body: 'Waiting for your choice.' }),
    ]);

    // No two adjacent messages share a role.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.role).not.toBe(out[i - 1]!.role);
    }
    // The four operator rows collapse to a single assistant message…
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    // …whose content preserves every part (joined), so the model still sees the steps.
    expect(out[1]!.content).toContain('list_views');
    expect(out[1]!.content).toContain('folio_api');
    expect(out[1]!.content).toContain('Confirm?');
    expect(out[1]!.content).toContain('Waiting for your choice.');
  });

  // The full confirm-resume thread: user → 7 operator rows → user → 4 operator
  // rows. Must reduce to a clean user/assistant/user/assistant alternation.
  test('a multi-turn thread alternates strictly after coalescing', () => {
    const opStep = (tool: string) =>
      row({ role: 'operator', kind: 'tool_step', payload: JSON.stringify({ tool, summary: 'ok', status: 'ok' }) });
    const out = rowsToMessages([
      row({ role: 'user', kind: 'text', body: 'remove the board view' }),
      opStep('list_workspaces'),
      opStep('list_projects'),
      opStep('folio_api_get'),
      row({ role: 'operator', kind: 'component', payload: JSON.stringify({ type: 'choice_card', prompt: 'Delete Board?' }) }),
      row({ role: 'operator', kind: 'text', body: 'Confirm above.' }),
      row({ role: 'user', kind: 'text', body: 'I chose: Yes' }),
      opStep('folio_api'),
      row({ role: 'operator', kind: 'component', payload: JSON.stringify({ type: 'choice_card', prompt: 'Confirm DELETE?' }) }),
      row({ role: 'operator', kind: 'text', body: 'Approve above.' }),
    ]);

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.role).not.toBe(out[i - 1]!.role);
    }
  });

  // Empty text bodies are still dropped, and dropping one must not create a
  // false same-role adjacency that then fails to coalesce.
  test('drops empty text bodies and still alternates', () => {
    const out = rowsToMessages([
      row({ role: 'user', kind: 'text', body: 'hi' }),
      row({ role: 'operator', kind: 'text', body: '   ' }), // dropped
      row({ role: 'operator', kind: 'text', body: 'hello' }),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[1]!.content).toBe('hello');
  });
});

describe('skillsToMessages — the operator must RECEIVE its skills (the cockpit "skill not followed" fix)', () => {
  // The root cause (2026-06-06 Multica study): the conversation/cockpit path never
  // injected the agent's skills, so the `folio` API manual was loaded into context
  // then dropped. The document path (buildInitialMessages) injects them; this brings
  // the conversation path to parity. Invariant 11: trusted → trusted channel,
  // unblessed → untrusted DATA envelope, on BOTH the API and cc paths.

  test('a TRUSTED skill rides a leading trusted-labelled USER message', () => {
    const msgs = skillsToMessages([
      { slug: 'folio', body: 'FOLIO_API_MANUAL_MARKER: how to drive the API', trusted: true },
    ]);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('user');
    // The trusted label from buildInitialMessages (runner.ts:1065) — one source of truth.
    expect(msgs[0]!.content).toContain('Treat as trusted instructions/reference');
    expect(msgs[0]!.content).toContain('FOLIO_API_MANUAL_MARKER');
  });

  test('an UNBLESSED skill rides the untrusted-DATA envelope, NOT the trusted block', () => {
    const msgs = skillsToMessages([
      { slug: 'sketchy', body: 'UNBLESSED_MARKER', trusted: false },
    ]);
    expect(msgs.length).toBe(1);
    // Must NOT be presented as trusted instructions.
    expect(msgs[0]!.content).not.toContain('Treat as trusted instructions/reference');
    // Must be labelled untrusted DATA (the runner.ts:1078 framing).
    expect(msgs[0]!.content.toLowerCase()).toContain('untrusted');
    expect(msgs[0]!.content).toContain('UNBLESSED_MARKER');
  });

  test('trusted block precedes unblessed block (ordering mirrors buildInitialMessages)', () => {
    const msgs = skillsToMessages([
      { slug: 'sketchy', body: 'UNBLESSED_MARKER', trusted: false },
      { slug: 'folio', body: 'TRUSTED_MARKER', trusted: true },
    ]);
    const trustedIdx = msgs.findIndex((m) => m.content.includes('TRUSTED_MARKER'));
    const unblessedIdx = msgs.findIndex((m) => m.content.includes('UNBLESSED_MARKER'));
    expect(trustedIdx).toBeGreaterThanOrEqual(0);
    expect(unblessedIdx).toBeGreaterThan(trustedIdx);
  });

  test('no skills → no messages (operator with no declared skills is unaffected)', () => {
    expect(skillsToMessages([])).toEqual([]);
  });

  test('prepended skills coalesce with the first user row — NO "roles must alternate" regression', () => {
    // The 151b827 constraint: the trusted preamble is a USER message; the first
    // replayed conversation row is ALSO user. They must merge into one user turn,
    // never produce two consecutive user messages (Anthropic 400).
    const preamble = skillsToMessages([{ slug: 'folio', body: 'MANUAL', trusted: true }]);
    const replayed = rowsToMessages([
      row({ role: 'user', kind: 'text', body: 'remove the board view' }),
      row({ role: 'operator', kind: 'text', body: 'Done.' }),
    ]);
    // Compose the way buildConversationMessages will: run BOTH through coalescing.
    const out = rowsToMessages([
      ...preamble.map((m) => row({ role: m.role === 'user' ? 'user' : 'operator', kind: 'text', body: m.content })),
      row({ role: 'user', kind: 'text', body: 'remove the board view' }),
      row({ role: 'operator', kind: 'text', body: 'Done.' }),
    ]);
    // Strict alternation holds; the skill+first-user-message become one user turn.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.role).not.toBe(out[i - 1]!.role);
    }
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toContain('MANUAL');
    expect(out[0]!.content).toContain('remove the board view');
    void replayed;
  });
});
