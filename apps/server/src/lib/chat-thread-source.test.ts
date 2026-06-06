import { describe, expect, test } from 'bun:test';
import { rowsToMessages } from './chat-thread-source.ts';
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
