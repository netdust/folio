import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { bodyExcerpt } from '../../lib/excerpt.ts';
import type { TreeNode } from '../../lib/wiki-tree.ts';

interface Props {
  node: TreeNode;
  onOpen: (slug: string) => void;
  onAddChild: (parentId: string) => void;
  renderChildren: (node: TreeNode) => React.ReactNode;
}

export function WikiCard({ node, onOpen, onAddChild, renderChildren }: Props) {
  const [expanded, setExpanded] = useState(false);
  const childCount = node.children.length;
  const excerpt = bodyExcerpt(node.doc.body ?? '');

  return (
    <div
      data-testid={`wiki-card-${node.doc.slug}`}
      className="flex flex-col rounded-md border border-border-light bg-content p-3 transition-colors hover:border-border"
    >
      <div className="flex items-start gap-2">
        <Icon icon={FileText} size={16} className="mt-0.5 text-fg-3" />
        <button
          type="button"
          onClick={() => onOpen(node.doc.slug)}
          className="flex-1 truncate text-left text-sm font-medium text-fg"
        >
          {node.doc.title}
        </button>
        <button
          type="button"
          aria-label={`Add child page under ${node.doc.title}`}
          onClick={() => onAddChild(node.doc.id)}
          className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg"
        >
          <Icon icon={Plus} size={14} />
        </button>
      </div>
      {excerpt ? <p className="mt-2 line-clamp-2 text-xs text-fg-2">{excerpt}</p> : null}
      {childCount > 0 ? (
        <button
          type="button"
          aria-label={expanded ? `Collapse ${node.doc.title}` : `Expand ${node.doc.title}`}
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 inline-flex w-fit items-center gap-1 text-[11px] text-fg-3 hover:text-fg-2"
        >
          <Icon icon={expanded ? ChevronDown : ChevronRight} size={16} />
          {childCount} {childCount === 1 ? 'page' : 'pages'}
        </button>
      ) : null}
      {expanded && childCount > 0 ? (
        <div className="mt-2 border-t border-border-light pt-2">{renderChildren(node)}</div>
      ) : null}
    </div>
  );
}
