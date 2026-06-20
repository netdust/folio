import { describe, expect, it } from 'vitest';
import type { Field } from '../../lib/api/fields.ts';
import { filterableFields } from './filterable-fields.ts';

const pinned = (key: string, type: Field['type'] = 'string'): Field => ({
  id: key,
  key,
  type,
  label: null,
  options: null,
  required: false,
  order: 0,
});

const doc = (frontmatter: Record<string, unknown>) => ({ frontmatter });

describe('filterableFields', () => {
  it('keeps every pinned field', () => {
    const out = filterableFields([pinned('role', 'select')], []);
    expect(out.map((f) => f.key)).toContain('role');
  });

  it('synthesizes a field for an un-pinned frontmatter key (type inferred)', () => {
    // `provider` is just data, never pinned — it must still be offered.
    const out = filterableFields([], [doc({ provider: 'Juliette' }), doc({ headcount: 12 })]);
    const byKey = (k: string) => out.find((f) => f.key === k);
    expect(byKey('provider')?.type).toBe('string');
    expect(byKey('headcount')?.type).toBe('number');
  });

  it('derives multi_select options for an un-pinned array key', () => {
    const out = filterableFields([], [doc({ tags: ['a', 'b'] }), doc({ tags: ['b', 'c'] })]);
    const tags = out.find((f) => f.key === 'tags');
    expect(tags?.type).toBe('multi_select');
    expect(tags?.options).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate a key that is both pinned and present in data (pinned wins)', () => {
    const out = filterableFields([pinned('role', 'select')], [doc({ role: 'performer' })]);
    expect(out.filter((f) => f.key === 'role')).toHaveLength(1);
    expect(out.find((f) => f.key === 'role')?.type).toBe('select');
  });

  it('returns only pinned fields when there are no docs', () => {
    const out = filterableFields([pinned('a'), pinned('b')], []);
    expect(out.map((f) => f.key)).toEqual(['a', 'b']);
  });
});
