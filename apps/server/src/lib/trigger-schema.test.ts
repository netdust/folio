import { describe, test, expect } from 'bun:test';
import { triggerFrontmatterSchema, validateCronShape, KNOWN_EVENT_KINDS } from './trigger-schema.ts';

describe('validateCronShape', () => {
  test('accepts 5-field cron expressions', () => {
    expect(validateCronShape('0 9 * * 1').ok).toBe(true);
    expect(validateCronShape('* * * * *').ok).toBe(true);
    expect(validateCronShape('*/5 * * * *').ok).toBe(true);
    expect(validateCronShape('0 0 1,15 * *').ok).toBe(true);
  });

  test('rejects expressions with wrong number of fields', () => {
    expect(validateCronShape('0 9 * *').ok).toBe(false);
    expect(validateCronShape('0 9 * * * *').ok).toBe(false);
    expect(validateCronShape('').ok).toBe(false);
  });

  test('rejects expressions with invalid characters', () => {
    expect(validateCronShape('a b c d e').ok).toBe(false);
    expect(validateCronShape('@daily').ok).toBe(false);
  });
});

describe('triggerFrontmatterSchema', () => {
  test('accepts schedule-only triggers', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: '0 9 * * 1',
      on_event: null,
    });
    expect(r.success).toBe(true);
  });

  test('accepts event-only triggers', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: null,
      on_event: 'document.updated',
    });
    expect(r.success).toBe(true);
  });

  test('accepts both schedule and on_event set', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: '0 9 * * 1',
      on_event: 'document.updated',
    });
    expect(r.success).toBe(true);
  });

  test('rejects triggers with both schedule and on_event null', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'triage-bot',
      schedule: null,
      on_event: null,
    });
    expect(r.success).toBe(false);
  });

  test('rejects unknown on_event kinds', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'x',
      schedule: null,
      on_event: 'document.exploded',
    });
    expect(r.success).toBe(false);
  });

  test('rejects bad cron expressions', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'x',
      schedule: 'every monday',
      on_event: null,
    });
    expect(r.success).toBe(false);
  });

  test('rejects last_fired_at and last_status when set by the client', () => {
    const a = triggerFrontmatterSchema.safeParse({
      agent: 'x', schedule: '* * * * *', on_event: null, last_fired_at: '2026-05-25',
    });
    expect(a.success).toBe(false);
    const b = triggerFrontmatterSchema.safeParse({
      agent: 'x', schedule: '* * * * *', on_event: null, last_status: 'ok',
    });
    expect(b.success).toBe(false);
  });

  test('applies enabled default true', () => {
    const r = triggerFrontmatterSchema.safeParse({
      agent: 'x', schedule: '* * * * *', on_event: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.enabled).toBe(true);
  });
});

describe('triggerFrontmatterSchema — Phase 2.6 sub-phase D extensions', () => {
  test('accepts $event.<key> in the agent field', () => {
    const out = triggerFrontmatterSchema.parse({
      on_event: 'agent.task.assigned',
      schedule: null,
      agent: '$event.assignee_slug',
      enabled: false,
    });
    expect(out.agent).toBe('$event.assignee_slug');
  });

  test('accepts internal_action enum', () => {
    const out = triggerFrontmatterSchema.parse({
      on_event: 'comment.created',
      schedule: null,
      agent: null,
      internal_action: 'resume_run',
      enabled: true,
    });
    expect(out.internal_action).toBe('resume_run');
  });

  test('accepts builtin: true flag', () => {
    const out = triggerFrontmatterSchema.parse({
      on_event: 'comment.mentioned',
      schedule: null,
      agent: null,
      builtin: true,
      enabled: false,
    });
    expect(out.builtin).toBe(true);
  });

  test('defaults builtin to false when absent', () => {
    const out = triggerFrontmatterSchema.parse({
      on_event: 'comment.created',
      schedule: null,
      agent: 'drafter',
    });
    expect(out.builtin).toBe(false);
  });

  test('accepts malformed $event.<key> as a plain string fallback', () => {
    // The regex variant exists for clarity / documentation, not exclusion. A
    // string like "$event.BAD-KEY" fails the regex variant but is still a
    // non-empty string, so the plain-string union member accepts it. This is
    // intentional — the schema doesn't gate slug shape, only emptiness.
    const r = triggerFrontmatterSchema.safeParse({
      on_event: 'agent.task.assigned',
      schedule: null,
      agent: '$event.BAD-KEY',
      enabled: false,
    });
    expect(r.success).toBe(true);
  });

  test('rejects unknown internal_action value', () => {
    const r = triggerFrontmatterSchema.safeParse({
      on_event: 'comment.created',
      schedule: null,
      agent: null,
      internal_action: 'unknown_action',
    });
    expect(r.success).toBe(false);
  });

  test('accepts null agent', () => {
    const r = triggerFrontmatterSchema.safeParse({
      on_event: 'comment.created',
      schedule: null,
      agent: null,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  test('accepts omitted agent field', () => {
    const r = triggerFrontmatterSchema.safeParse({
      on_event: 'comment.created',
      schedule: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('KNOWN_EVENT_KINDS', () => {
  test('includes the document, field, view, table, project, workspace kinds', () => {
    expect(KNOWN_EVENT_KINDS).toContain('document.created');
    expect(KNOWN_EVENT_KINDS).toContain('document.updated');
    expect(KNOWN_EVENT_KINDS).toContain('field.created');
    expect(KNOWN_EVENT_KINDS).toContain('view.created');
    expect(KNOWN_EVENT_KINDS).toContain('table.created');
    expect(KNOWN_EVENT_KINDS).toContain('project.created');
    expect(KNOWN_EVENT_KINDS).toContain('workspace.created');
    expect(KNOWN_EVENT_KINDS).toContain('activity.logged');
  });

  test('includes the 4 new Phase-2.6 event kinds', () => {
    expect(KNOWN_EVENT_KINDS).toContain('comment.created');
    expect(KNOWN_EVENT_KINDS).toContain('comment.mentioned');
    expect(KNOWN_EVENT_KINDS).toContain('comment.deleted');
    expect(KNOWN_EVENT_KINDS).toContain('agent.allow_list.reconciled');
  });

  test('triggerFrontmatterSchema accepts the new comment and agent kinds as on_event', () => {
    for (const kind of ['comment.created', 'comment.mentioned', 'comment.deleted', 'agent.allow_list.reconciled'] as const) {
      const r = triggerFrontmatterSchema.safeParse({
        agent: 'x',
        schedule: null,
        on_event: kind,
      });
      expect(r.success).toBe(true);
    }
  });
});
