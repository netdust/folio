import { describe, it, expect, vi } from 'vitest';
import { slashRegistry, filterSlash, type SlashContext } from './slash-registry.ts';

function ctxFor(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    documents: [],
    aiConfigured: false,
    insert: vi.fn(),
    replace: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
}

describe('slash registry', () => {
  it('filters items by query', () => {
    expect(filterSlash(slashRegistry, '')).toEqual(slashRegistry);
    expect(filterSlash(slashRegistry, 'link').map((i) => i.id)).toEqual(['link']);
    expect(filterSlash(slashRegistry, 'sum').map((i) => i.id)).toEqual(['summarize']);
  });

  it('/link replaces with [[slug]] on match', () => {
    const link = slashRegistry.find((i) => i.id === 'link')!;
    const ctx = ctxFor({
      documents: [
        {
          id: 'd1',
          slug: 'fix-login',
          type: 'work_item',
          title: 'Fix login bug',
          status: null,
          parentId: null,
          frontmatter: {},
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    link.onSelect(ctx, 'login');
    expect(ctx.replace).toHaveBeenCalledWith('[[fix-login]]');
  });

  it('/link notifies when no match', () => {
    const link = slashRegistry.find((i) => i.id === 'link')!;
    const ctx = ctxFor();
    link.onSelect(ctx, 'mystery');
    expect(ctx.notify).toHaveBeenCalledWith('No matching document', 'warning');
  });

  it('AI items are disabled when aiConfigured=false', () => {
    const draft = slashRegistry.find((i) => i.id === 'draft')!;
    expect(draft.isEnabled!(ctxFor({ aiConfigured: false }))).toBe(false);
    expect(draft.isEnabled!(ctxFor({ aiConfigured: true }))).toBe(true);
  });
});
