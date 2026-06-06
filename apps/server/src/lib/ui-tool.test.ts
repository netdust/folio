import { describe, expect, test } from 'bun:test';
import { choiceCardSchema, linkPanelSchema } from './ui-tool.ts';

describe('ui tool schemas', () => {
  test('link_panel accepts a document/work_item target WITH a pslug', () => {
    const r = linkPanelSchema.safeParse({
      target: { entityType: 'work_item', entityId: 'untitled-4', wslug: 'netdust', pslug: 'client-website' },
      title: 'Untitled 4',
    });
    expect(r.success).toBe(true);
  });

  test('link_panel REQUIRES pslug for a document/work_item target', () => {
    // document/work_item open at the project route (/w/$wslug/p/$pslug/...?doc=);
    // without the project slug there's no resolvable destination, so the schema
    // rejects it rather than letting the operator emit an unresolvable link.
    for (const entityType of ['document', 'work_item'] as const) {
      const r = linkPanelSchema.safeParse({
        target: { entityType, entityId: 'x', wslug: 'acme' }, // no pslug
        title: 'X',
      });
      expect(r.success).toBe(false);
    }
  });

  test('link_panel accepts agent/trigger WITHOUT a pslug (workspace-level)', () => {
    const r = linkPanelSchema.safeParse({
      target: { entityType: 'agent', entityId: 'op', wslug: 'acme' },
      title: 'Operator',
    });
    expect(r.success).toBe(true);
  });

  test('link_panel rejects an unknown entityType', () => {
    const r = linkPanelSchema.safeParse({
      target: { entityType: 'galaxy', entityId: 'x', wslug: 'acme' },
      title: 'X',
    });
    expect(r.success).toBe(false);
  });

  test('ask_choice requires at least two options each with an id+label', () => {
    expect(
      choiceCardSchema.safeParse({
        prompt: 'Which?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      }).success,
    ).toBe(true);
    // fewer than two options is rejected
    expect(
      choiceCardSchema.safeParse({ prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }).success,
    ).toBe(false);
    // an option missing its id is rejected
    expect(
      choiceCardSchema.safeParse({
        prompt: 'Which?',
        options: [{ label: 'A' }, { id: 'b', label: 'B' }],
      }).success,
    ).toBe(false);
  });
});
