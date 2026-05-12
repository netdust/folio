import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useDocuments, useCreateDocument } from '../../lib/api/documents.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Button } from '../ui/button.tsx';
import { EmptyState } from './empty-state.tsx';
import { buildTree, type TreeNode } from '../../lib/wiki-tree.ts';

interface Props { wslug: string; pslug: string; }

export function WikiTree({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const listParams = useMemo(
    () => ({ type: 'page' as const, sort: 'title' as const, dir: 'asc' as const, limit: 200 }),
    [],
  );
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, listParams);
  const create = useCreateDocument(wslug, pslug);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(page?.data ?? []), [page]);

  const openDoc = (slug: string) => {
    void navigate({ to: '.', search: { ...search, doc: slug }, replace: false });
  };

  const onNewPage = async () => {
    try {
      const p = await create.mutateAsync({ type: 'page', title: 'Untitled' });
      openDoc(p.slug);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  if (isLoading) return <div className="p-4 text-fg-3">Loading…</div>;
  if (error) return <div className="p-4 text-danger">Failed to load wiki.</div>;
  if (tree.length === 0) {
    return (
      <EmptyState
        title="No pages yet"
        description="Create your first wiki page."
        action={{ label: 'New page', onClick: onNewPage }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 px-[22px] py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-fg-3">Wiki</span>
        <Button variant="secondary" onClick={onNewPage} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'New page'}
        </Button>
      </div>
      <ul className="flex flex-col">
        {tree.map((node) => (
          <TreeRow
            key={node.doc.id}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={(id) => setExpanded((p) => {
              const n = new Set(p);
              if (n.has(id)) n.delete(id); else n.add(id);
              return n;
            })}
            onOpen={openDoc}
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (slug: string) => void;
}

export function TreeRow({ node, depth, expanded, onToggle, onOpen }: RowProps) {
  const isExpanded = expanded.has(node.doc.id);
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <div
        className="grid grid-cols-[24px_1fr] items-center gap-1 rounded-sm py-1 pr-2 hover:bg-card"
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <button
          type="button"
          aria-label={hasChildren ? (isExpanded ? `Collapse ${node.doc.title}` : `Expand ${node.doc.title}`) : undefined}
          onClick={() => hasChildren && onToggle(node.doc.id)}
          className={`inline-grid h-6 w-6 place-items-center text-fg-3 ${hasChildren ? 'cursor-pointer hover:text-fg' : 'cursor-default opacity-0'}`}
          tabIndex={hasChildren ? 0 : -1}
        >
          <span className="font-mono text-[10px]">{isExpanded ? '▾' : '▸'}</span>
        </button>
        <button
          type="button"
          onClick={() => onOpen(node.doc.slug)}
          className="truncate text-left text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {node.doc.title}
        </button>
      </div>
      {isExpanded && hasChildren ? (
        <ul className="flex flex-col">
          {node.children.map((c) => (
            <TreeRow
              key={c.doc.id}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
