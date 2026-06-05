/**
 * Operator cockpit chat (Task 8) — interrupted-turn boot recovery (M12).
 *
 * TIER A (correctness of a self-healing boot sweep over persisted state — a crash
 * mid act-then-report must never leave the composer wedged OR the human blind to
 * what was applied). RED-first: assert the stale slot is cleared AND a terminal
 * summary of the tool_step rows is appended.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { conversations } from '../db/schema.ts';
import { makeBareTestDb } from '../test/harness.ts';
import {
  appendMessage,
  createConversation,
  getThread,
  recoverInterruptedConversations,
} from '../services/conversations.ts';

let db: Awaited<ReturnType<typeof makeBareTestDb>>['db'];

beforeEach(async () => {
  ({ db } = await makeBareTestDb());
});

describe('recoverInterruptedConversations (M12)', () => {
  it('clears a stale active_run_id AND appends a summary of the tool_step rows', async () => {
    const c = await createConversation(db, { createdBy: 'u1', operatorAgentId: 'op1', title: 'X' });
    // Persisted steps from the crashed turn, stamped with the run id.
    await appendMessage(db, {
      conversationId: c.id,
      role: 'operator',
      kind: 'tool_step',
      payload: { tool: 'create_document', summary: 'Created Onboard Acme', status: 'ok' },
      runId: 'run-crash',
    });
    await appendMessage(db, {
      conversationId: c.id,
      role: 'operator',
      kind: 'tool_step',
      payload: { tool: 'update_document', summary: 'Set status', status: 'ok' },
      runId: 'run-crash',
    });
    // The slot survives the crash (no completion ever cleared it).
    await db.update(conversations).set({ activeRunId: 'run-crash' }).where(eq(conversations.id, c.id));

    const recovered = await recoverInterruptedConversations(db);
    expect(recovered).toBe(1);

    // Slot cleared → composer unwedged.
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, c.id) });
    expect(row?.activeRunId).toBeNull();

    // A terminal summary message naming the completed tools was appended.
    const thread = await getThread(db, c.id);
    const last = thread.at(-1)!;
    expect(last.kind).toBe('text');
    expect(last.role).toBe('operator');
    expect(last.body).toContain('previous turn was interrupted');
    expect(last.body).toContain('create_document');
    expect(last.body).toContain('update_document');
  });

  it('summarizes "before any tools ran" when the crashed turn did nothing', async () => {
    const c = await createConversation(db, { createdBy: 'u1', operatorAgentId: 'op1', title: 'X' });
    await db.update(conversations).set({ activeRunId: 'run-empty' }).where(eq(conversations.id, c.id));

    await recoverInterruptedConversations(db);
    const thread = await getThread(db, c.id);
    expect(thread.at(-1)!.body).toContain('before any tools ran');
    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, c.id) });
    expect(row?.activeRunId).toBeNull();
  });

  it('is a no-op for conversations with no active run', async () => {
    const c = await createConversation(db, { createdBy: 'u1', operatorAgentId: 'op1', title: 'X' });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'hi' });
    const recovered = await recoverInterruptedConversations(db);
    expect(recovered).toBe(0);
    const thread = await getThread(db, c.id);
    // No spurious summary appended.
    expect(thread.length).toBe(1);
  });
});
