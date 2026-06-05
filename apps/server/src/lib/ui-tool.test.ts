import { describe, expect, test } from 'bun:test';
import { choiceCardSchema, linkPanelSchema } from './ui-tool.ts';

describe('ui tool schemas', () => {
  test('link_panel accepts a valid entity target', () => {
    const r = linkPanelSchema.safeParse({
      target: { entityType: 'document', entityId: 'onboard-acme', wslug: 'acme' },
      title: 'Onboard Acme',
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
