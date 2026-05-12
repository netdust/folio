import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { toast } from 'sonner';
import { useDocuments, useCreateDocument, useUpdateDocument } from '../../lib/api/documents.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { Button } from '../ui/button.tsx';
import { EmptyState } from './empty-state.tsx';
import { RowContextMenu } from './row-context-menu.tsx';
import { buildTree, descendantIds, type TreeNode } from '../../lib/wiki-tree.ts';
import { cn } from '../ui/cn.ts';

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
  const update = useUpdateDocument(wslug, pslug, listParams);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(page?.data ?? []), [page]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const dragId = String(active.id);
    const dropId = String(over.id);
    if (dragId === dropId) return;

    // Cycle guard: reject if drop target is a descendant of the dragged node
    const desc = descendantIds(tree, dragId);
    if (desc.has(dropId)) {
      toast.error('Cannot move a page into its own descendant.');
      return;
    }

    const dragDoc = (active.data.current as { doc?: { slug: string; parentId: string | null } } | undefined)?.doc;
    if (!dragDoc) return;

    // No-op if already parented there
    if (dragDoc.parentId === dropId) return;

    setPendingId(dragId);
    try {
      await update.mutateAsync({ slug: dragDoc.slug, patch: { parentId: dropId } });
      // Auto-expand the drop target so the user can see the dropped node
      setExpanded((p) => new Set(p).add(dropId));
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setPendingId(null);
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
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
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
              pendingId={pendingId}
              wslug={wslug}
              pslug={pslug}
            />
          ))}
        </ul>
      </DndContext>
    </div>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (slug: string) => void;
  pendingId: string | null;
  wslug: string;
  pslug: string;
}

export function TreeRow({ node, depth, expanded, onToggle, onOpen, pendingId, wslug, pslug }: RowProps) {
  const isExpanded = expanded.has(node.doc.id);
  const hasChildren = node.children.length > 0;
  const isPending = pendingId === node.doc.id;

  const draggable = useDraggable({
    id: node.doc.id,
    data: { doc: { slug: node.doc.slug, parentId: node.doc.parentId } },
  });
  const droppable = useDroppable({ id: node.doc.id });

  const setRef = (el: HTMLLIElement | null) => {
    draggable.setNodeRef(el);
    droppable.setNodeRef(el);
  };

  const onCopy = async () => {
    try {
      await copyDocumentAsMarkdown(wslug, pslug, node.doc.slug);
      toast.success('Copied as Markdown');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <li
      ref={setRef}
      {...draggable.listeners}
      {...draggable.attributes}
      className={cn(
        draggable.isDragging && 'opacity-50',
        droppable.isOver && 'ring-2 ring-primary ring-inset',
        isPending && 'opacity-60',
      )}
    >
      <RowContextMenu items={[{ label: 'Copy as Markdown', onSelect: onCopy, hint: '⌘⇧C' }]}>
        <div
          className="grid grid-cols-[24px_1fr] items-center gap-1 rounded-sm py-1 pr-2 hover:bg-card"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <button
            type="button"
            aria-label={hasChildren ? (isExpanded ? `Collapse ${node.doc.title}` : `Expand ${node.doc.title}`) : undefined}
            onClick={() => hasChildren && onToggle(node.doc.id)}
            onPointerDown={(e) => e.stopPropagation()}
            className={`inline-grid h-6 w-6 place-items-center text-fg-3 ${hasChildren ? 'cursor-pointer hover:text-fg' : 'cursor-default opacity-0'}`}
            tabIndex={hasChildren ? 0 : -1}
          >
            <span className="font-mono text-[10px]">{isExpanded ? '▾' : '▸'}</span>
          </button>
          <button
            type="button"
            onClick={() => onOpen(node.doc.slug)}
            onPointerDown={(e) => e.stopPropagation()}
            className="truncate text-left text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {node.doc.title}
          </button>
        </div>
      </RowContextMenu>
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
              pendingId={pendingId}
              wslug={wslug}
              pslug={pslug}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
