import { describe, expect, it } from 'vitest';
import { columnSuggestions, type ColumnSuggestion } from './column-suggestions.ts';
import type { Field } from '../../lib/api/fields.ts';

const f = (key: string, type: Field['type'] = 'string'): Field => ({
  id: key, key, type, label: null, options: null, required: false, order: 0,
});

const doc = (frontmatter: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  slug: 's',
  title: 't',
  type: 'work_item' as const,
  status: 'todo',
  body: '',
  frontmatter,
  parentId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('columnSuggestions', () => {
  it('returns frontmatter keys that are not pinned fields', () => {
    const docs = [doc({ owner: 'Alice', priority: 'high' }), doc({ owner: 'Bob' })];
    const fields = [f('priority')];
    const out = columnSuggestions(docs, fields);
    expect(out.map((s) => s.key)).toEqual(['owner']);
  });

  it('includes a sample value (first non-null occurrence)', () => {
    const docs = [doc({ owner: null }), doc({ owner: 'Alice' })];
    const out = columnSuggestions(docs, []);
    expect(out[0].sample).toBe('Alice');
  });

  it('infers type from sample value', () => {
    const docs = [
      doc({ price: 42 }),
      doc({ shipped: true }),
      doc({ due: '2026-06-01' }),
      doc({ note: 'hello' }),
      doc({ tags: ['a', 'b'] }),
    ];
    const out = columnSuggestions(docs, []);
    const byKey = (k: string) => out.find((s) => s.key === k) as ColumnSuggestion;
    expect(byKey('price').inferredType).toBe('number');
    expect(byKey('shipped').inferredType).toBe('boolean');
    expect(byKey('due').inferredType).toBe('date');
    expect(byKey('note').inferredType).toBe('string');
    expect(byKey('tags').inferredType).toBe('multi_select');
  });

  it('dedupes and sorts alphabetically', () => {
    const docs = [doc({ z: 1, a: 1 }), doc({ m: 1, a: 1 })];
    const out = columnSuggestions(docs, []);
    expect(out.map((s) => s.key)).toEqual(['a', 'm', 'z']);
  });

  it('returns an empty list when every key is already pinned', () => {
    const docs = [doc({ a: 1, b: 2 })];
    expect(columnSuggestions(docs, [f('a'), f('b')])).toEqual([]);
  });
});
