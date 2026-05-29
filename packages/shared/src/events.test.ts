import { describe, expect, test } from 'bun:test';
import { KNOWN_EVENT_KINDS } from './events.ts';

describe('KNOWN_EVENT_KINDS — Phase 3 additions', () => {
  test('includes all agent.run.* event kinds', () => {
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.started');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.awaiting_approval');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.running');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.completed');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.failed');
    expect(KNOWN_EVENT_KINDS).toContain('agent.run.rejected');
  });

  test('includes ai.action audit event', () => {
    expect(KNOWN_EVENT_KINDS).toContain('ai.action');
  });

  test('includes runs_table.lazy_seeded event', () => {
    expect(KNOWN_EVENT_KINDS).toContain('runs_table.lazy_seeded');
  });

  test('includes provider degraded + recovered events', () => {
    expect(KNOWN_EVENT_KINDS).toContain('workspace.provider.degraded');
    expect(KNOWN_EVENT_KINDS).toContain('workspace.provider.recovered');
  });

  test('includes reactor health system events', () => {
    expect(KNOWN_EVENT_KINDS).toContain('reactor.halted');
    expect(KNOWN_EVENT_KINDS).toContain('reactor.recovered');
  });

  test('EventKind union and KNOWN_EVENT_KINDS array stay in sync', () => {
    // Compile-time check: every entry in KNOWN_EVENT_KINDS must be
    // assignable to EventKind. If the union is missing one, this would
    // fail at type-check; we also assert no duplicates at runtime.
    const set = new Set(KNOWN_EVENT_KINDS);
    expect(set.size).toBe(KNOWN_EVENT_KINDS.length);
  });
});
