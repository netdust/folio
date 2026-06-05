/**
 * Operator cockpit chat — conversation/message persistence.
 *
 * DELIBERATE EXCEPTION to invariant 5 (every write emits an event): these writes
 * use PLAIN `db` transactions and emit NO events. Chat persistence is walled off
 * from the SSE stream + trigger-matcher by design (see ARCHITECTURE-INVARIANTS.md
 * "Deliberate exceptions"; threat model M10). Never route these through
 * `txWithEvents` / `emitEvent`.
 *
 * `seq` is allocated monotonically per conversation via `MAX(seq) + 1` inside the
 * same transaction as the insert. SQLite's writer lock serializes the max + insert
 * so the value is unique within a conversation. The single-active-turn CAS (M14,
 * Task 6) is the outer guarantee that two turns never append concurrently; this
 * allocator is correct within that model.
 */

import { eq, max } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { conversations, messages, type Message } from '../db/schema.ts';

export async function createConversation(
  db: DB,
  input: { createdBy: string; operatorAgentId: string; title: string },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  // created_at / updated_at default via SQL (unixepoch() * 1000) — omit on insert.
  await db.insert(conversations).values({
    id,
    title: input.title,
    createdBy: input.createdBy,
    operatorAgentId: input.operatorAgentId,
    activeRunId: null,
  });
  return { id };
}

export async function appendMessage(
  db: DB,
  input: {
    conversationId: string;
    role: 'user' | 'operator';
    kind: 'text' | 'tool_step' | 'component';
    body?: string;
    payload?: unknown;
    runId?: string;
  },
): Promise<Message> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId));
    const seq = (row?.value ?? 0) + 1;
    const inserted = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      seq,
      role: input.role,
      kind: input.kind,
      body: input.body ?? '',
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      runId: input.runId ?? null,
    };
    await tx.insert(messages).values(inserted);
    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));
    return (await tx.query.messages.findFirst({
      where: eq(messages.id, inserted.id),
    })) as Message;
  });
}

export async function getThread(db: DB, conversationId: string): Promise<Message[]> {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.seq)],
  });
}

export async function serializeThreadMarkdown(
  db: DB,
  conversationId: string,
): Promise<string> {
  const rows = await getThread(db, conversationId);
  const lines: string[] = [];
  for (const m of rows) {
    if (m.kind === 'text') {
      lines.push(`### ${m.role === 'user' ? 'User' : 'Operator'}\n\n${m.body}\n`);
    } else if (m.kind === 'tool_step') {
      const p = (m.payload ? JSON.parse(m.payload) : {}) as {
        tool?: string;
        summary?: string;
        status?: string;
      };
      lines.push(`- \`${p.tool ?? ''}\` — ${p.summary ?? ''} (${p.status ?? ''})`);
    } else if (m.kind === 'component') {
      const p = (m.payload ? JSON.parse(m.payload) : {}) as {
        type?: string;
        title?: string;
        prompt?: string;
        chosen?: string;
      };
      if (p.type === 'link_panel') {
        lines.push(`- [link: ${p.title ?? ''}]`);
      } else if (p.type === 'choice_card') {
        lines.push(`- Q: ${p.prompt ?? ''}${p.chosen ? ` → ${p.chosen}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}
