import { describe, expect, test } from 'bun:test';
import {
  agentRunFrontmatterSchema,
  runDoneReasonSchema,
  runStatusSchema,
  runErrorReasonSchema,
  isValidTransition,
  TERMINAL_STATUSES,
} from './agent-run-schema.ts';

describe('runStatusSchema', () => {
  test('accepts the six lifecycle statuses', () => {
    for (const s of [
      'planning',
      'awaiting_approval',
      'running',
      'completed',
      'failed',
      'rejected',
    ]) {
      expect(() => runStatusSchema.parse(s)).not.toThrow();
    }
  });
  test('rejects unknown', () => {
    expect(() => runStatusSchema.parse('queued')).toThrow();
  });
});

describe('runErrorReasonSchema', () => {
  test('accepts every documented reason', () => {
    for (const r of [
      'budget_exceeded', 'depth_exceeded', 'no_ai_key', 'provider_error',
      'cancelled', 'rejected', 'idempotency_violation',
      'rate_limited', 'fanout_exceeded', 'chain_duration_exceeded',
      'chain_tokens_exceeded', 'worker_crash',
    ]) {
      expect(() => runErrorReasonSchema.parse(r)).not.toThrow();
    }
  });

  // D-9.1 — 'tool_error' distinguishes "model couldn't self-correct after N
  // consecutive recoverable tool errors" from hard 'provider_error' failures.
  // Used by the runner in D-9.2 when it gives up feeding tool errors back.
  test('accepts tool_error', () => {
    expect(() => runErrorReasonSchema.parse('tool_error')).not.toThrow();
  });

  test('rejects unknown reason', () => {
    expect(() => runErrorReasonSchema.parse('flux_capacitor_error')).toThrow();
  });
});

describe('agentRunFrontmatterSchema', () => {
  const valid = {
    assignee: 'agent:reply-drafter',
    status: 'planning',
    agent_slug: 'reply-drafter',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    system_prompt: 'Reply tersely.',
    max_tokens: 4096,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: null,
    chain_id: '00000000-0000-7000-8000-000000000000',
    fired_by: '00000000-0000-7000-8000-000000000000:trigger:builtin-on-assignment',
    started_at: new Date().toISOString(),
  };
  test('accepts a valid minimal frontmatter', () => {
    expect(() => agentRunFrontmatterSchema.parse(valid)).not.toThrow();
  });
  test('rejects assignee not in agent:<slug> form', () => {
    expect(() => agentRunFrontmatterSchema.parse({ ...valid, assignee: 'reply-drafter' })).toThrow();
  });
  test('rejects unknown provider', () => {
    expect(() => agentRunFrontmatterSchema.parse({ ...valid, provider: 'gemini' })).toThrow();
  });
  test('rejects non-uuid chain_id', () => {
    expect(() => agentRunFrontmatterSchema.parse({ ...valid, chain_id: 'abc' })).toThrow();
  });
  test('error_reason must be from the union when present', () => {
    expect(() =>
      agentRunFrontmatterSchema.parse({ ...valid, status: 'failed', error_reason: 'bogus' }),
    ).toThrow();
  });

  // Round 7 #20 — done_reason mirrors ProviderEvent.done.reason. The widened
  // values (refusal, pause_turn) MUST round-trip through the persistence
  // schema so the Sub-phase C runner can store them without inventing fields
  // or collapsing distinct outcomes into 'provider_error'.
  test('accepts done_reason=refusal on a completed run', () => {
    expect(() =>
      agentRunFrontmatterSchema.parse({ ...valid, status: 'completed', done_reason: 'refusal' }),
    ).not.toThrow();
  });

  test('accepts done_reason=pause_turn on a completed run', () => {
    expect(() =>
      agentRunFrontmatterSchema.parse({ ...valid, status: 'completed', done_reason: 'pause_turn' }),
    ).not.toThrow();
  });

  test('accepts the three canonical done_reason values', () => {
    for (const dr of ['stop', 'tool_use', 'max_tokens']) {
      expect(() =>
        agentRunFrontmatterSchema.parse({ ...valid, status: 'completed', done_reason: dr }),
      ).not.toThrow();
    }
  });

  test('rejects unknown done_reason', () => {
    expect(() =>
      agentRunFrontmatterSchema.parse({
        ...valid,
        status: 'completed',
        done_reason: 'safety_pause',
      }),
    ).toThrow();
  });

  test('done_reason is optional (pre-Sub-phase-C rows have no value)', () => {
    expect(() => agentRunFrontmatterSchema.parse(valid)).not.toThrow();
  });
});

describe('runDoneReasonSchema', () => {
  test('accepts the five ProviderEvent done.reason values', () => {
    for (const r of ['stop', 'tool_use', 'max_tokens', 'refusal', 'pause_turn']) {
      expect(() => runDoneReasonSchema.parse(r)).not.toThrow();
    }
  });
  test('rejects unknown', () => {
    expect(() => runDoneReasonSchema.parse('content_filter')).toThrow();
  });
});

import { providerSchema } from './agent-run-schema.ts';
test('providerSchema accepts claude-code', () => {
  expect(providerSchema.parse('claude-code')).toBe('claude-code');
});

describe('isValidTransition', () => {
  test('planning → awaiting_approval | running | failed', () => {
    expect(isValidTransition('planning', 'awaiting_approval')).toBe(true);
    expect(isValidTransition('planning', 'running')).toBe(true);
    expect(isValidTransition('planning', 'failed')).toBe(true);
    expect(isValidTransition('planning', 'completed')).toBe(false);
    expect(isValidTransition('planning', 'rejected')).toBe(false);
  });
  test('awaiting_approval → running | rejected | failed', () => {
    expect(isValidTransition('awaiting_approval', 'running')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'rejected')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'failed')).toBe(true);
    expect(isValidTransition('awaiting_approval', 'completed')).toBe(false);
  });
  test('running → completed | failed', () => {
    expect(isValidTransition('running', 'completed')).toBe(true);
    expect(isValidTransition('running', 'failed')).toBe(true);
    expect(isValidTransition('running', 'rejected')).toBe(false);
  });
  test('no transitions out of terminal states', () => {
    for (const term of TERMINAL_STATUSES) {
      for (const next of runStatusSchema.options) {
        expect(isValidTransition(term, next)).toBe(false);
      }
    }
  });
});
