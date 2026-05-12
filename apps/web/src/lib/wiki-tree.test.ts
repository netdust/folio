import { describe, it, expect } from 'vitest';
import { buildTree, descendantIds } from './wiki-tree.ts';
import type { DocumentSummary } from './api/documents.ts';

function page(id: string, title: string, parentId: string | null = null): DocumentSummary {
  return {
    id, slug: id, type: 'page', title, status: null, parentId,
    frontmatter: {}, createdAt: '', updatedAt: '',
  };
}

describe('buildTree', () => {
  it('groups children under parents and sorts alphabetically', () => {
    const tree = buildTree([
      page('1', 'Beta'),
      page('2', 'Alpha'),
      page('3', 'Beta-Two', '1'),
      page('4', 'Beta-One', '1'),
    ]);
    expect(tree.map((n) => n.doc.title)).toEqual(['Alpha', 'Beta']);
    const beta = tree[1]!;
    expect(beta.children.map((n) => n.doc.title)).toEqual(['Beta-One', 'Beta-Two']);
  });

  it('promotes orphans (parentId references a missing or deleted page) to roots', () => {
    const tree = buildTree([
      page('1', 'Lonely', 'deleted-parent'),
      page('2', 'Root'),
    ]);
    expect(tree.map((n) => n.doc.title)).toEqual(['Lonely', 'Root']);
  });

  it('descendantIds collects all transitive children', () => {
    const tree = buildTree([
      page('a', 'A'),
      page('b', 'B', 'a'),
      page('c', 'C', 'b'),
      page('d', 'D'),
    ]);
    const desc = descendantIds(tree, 'a');
    expect([...desc].sort()).toEqual(['b', 'c']);
  });
});
