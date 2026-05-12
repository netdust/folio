import type { DocumentSummary } from './api/documents.ts';

export interface TreeNode {
  doc: DocumentSummary;
  children: TreeNode[];
}

export function buildTree(pages: DocumentSummary[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const p of pages) byId.set(p.id, { doc: p, children: [] });

  const roots: TreeNode[] = [];
  for (const p of pages) {
    const node = byId.get(p.id)!;
    if (p.parentId && byId.has(p.parentId)) {
      byId.get(p.parentId)!.children.push(node);
    } else {
      // Either no parentId, or parent isn't a page (was deleted, or wrong type) — promote to root.
      roots.push(node);
    }
  }

  // Sort each level alphabetically by title; stable.
  const sortLevel = (level: TreeNode[]) => {
    level.sort((a, b) => a.doc.title.localeCompare(b.doc.title));
    for (const n of level) sortLevel(n.children);
  };
  sortLevel(roots);

  return roots;
}

/** Returns the set of node IDs that are descendants of `nodeId` (excluding nodeId). */
export function descendantIds(tree: TreeNode[], nodeId: string): Set<string> {
  const out = new Set<string>();
  const walkFrom = (node: TreeNode) => {
    for (const c of node.children) {
      out.add(c.doc.id);
      walkFrom(c);
    }
  };
  const find = (level: TreeNode[]): TreeNode | null => {
    for (const n of level) {
      if (n.doc.id === nodeId) return n;
      const f = find(n.children);
      if (f) return f;
    }
    return null;
  };
  const start = find(tree);
  if (start) walkFrom(start);
  return out;
}
