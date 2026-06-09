import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, FolderTree, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useDocuments, useCreateDocument, useUpdateDocument } from '../../lib/api/documents.ts';
import { DEFAULT_TABLE_SLUG } from '../../lib/default-table.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { Icon } from '../ui/icon.tsx';
import { EmptyState } from './empty-state.tsx';
import { RowContextMenu } from './row-context-menu.tsx';
import { WikiSkeleton } from './wiki-skeleton.tsx';
import { buildTree, descendantIds, type TreeNode } from '../../lib/wiki-tree.ts';
import { WikiCard } from './wiki-card.tsx';
import { cn } from '../ui/cn.ts';

interface Props { wslug: string; pslug: string; }

export function WikiTree({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const listParams = useMemo(
    () => ({ type: 'page' as const, sort: 'title' as const, dir: 'asc' as const, limit: 200 }),
    [],
  );
  // WikiTree renders type:'page' documents, which are PROJECT-scoped server-side
  // (a page fetch enforces `tableId IS NULL` — see documents.ts: only
  // type:'work_item' is constrained by the active table). tslug is required by
  // the hook signature but ignored for pages, so DEFAULT_TABLE_SLUG is the
  // honest constant — the wiki route carries no :tslug param.
  const { data: page, isLoading, error } = useDocuments(wslug, pslug, DEFAULT_TABLE_SLUG, listParams);
  const create = useCreateDocument(wslug, pslug, DEFAULT_TABLE_SLUG);
  const update = useUpdateDocument(wslug, pslug, DEFAULT_TABLE_SLUG, listParams);
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

  const onAddChild = async (parentId: string) => {
    try {
      const p = await create.mutateAsync({ type: 'page', title: 'Untitled', parentId });
      // Auto-expand the parent so the new child is visible on return from
      // the slideover.
      setExpanded((prev) => new Set(prev).add(parentId));
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

  if (isLoading) return <WikiSkeleton />;
  if (error) return <div className="p-4 text-danger">Failed to load wiki.</div>;
  if (tree.length === 0) {
    return (
      <EmptyState
        icon={<Icon icon={FolderTree} size={20} />}
        title="No pages yet"
        description="Create your first wiki page."
        action={{ label: 'Create your first page', onClick: onNewPage }}
      />
    );
  }

  // MainFrame's children container already supplies px-[22px] py-2 — don't
  // double it up here.
  return (
    <div className="flex h-full flex-col gap-2">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {/* Roots render as cards; the existing TreeRow tree (with
            drag-to-reparent) lives inside each expanded card's subtree.
            Root-level reparent via cards is out of scope. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tree.map((node) => (
            <WikiCard
              key={node.doc.id}
              node={node}
              onOpen={openDoc}
              onAddChild={onAddChild}
              renderChildren={(n) => (
                <ul className="flex flex-col">
                  {n.children.map((c) => (
                    <TreeRow
                      key={c.doc.id}
                      node={c}
                      depth={0}
                      expanded={expanded}
                      onToggle={(id) => setExpanded((p) => {
                        const s = new Set(p);
                        if (s.has(id)) s.delete(id); else s.add(id);
                        return s;
                      })}
                      onOpen={openDoc}
                      onAddChild={onAddChild}
                      pendingId={pendingId}
                      wslug={wslug}
                      pslug={pslug}
                    />
                  ))}
                </ul>
              )}
            />
          ))}
        </div>
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
  onAddChild: (parentId: string) => void;
  pendingId: string | null;
  wslug: string;
  pslug: string;
}

export function TreeRow({ node, depth, expanded, onToggle, onOpen, onAddChild, pendingId, wslug, pslug }: RowProps) {
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
          className="group/row grid grid-cols-[24px_1fr_auto] items-center gap-1 rounded-sm py-1 pr-2 hover:bg-card"
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
            <Icon icon={isExpanded ? ChevronDown : ChevronRight} size={14} />
          </button>
          <button
            type="button"
            onClick={() => onOpen(node.doc.slug)}
            onPointerDown={(e) => e.stopPropagation()}
            className="truncate text-left text-sm text-fg"
          >
            {node.doc.title}
          </button>
          <button
            type="button"
            aria-label={`Add child page under ${node.doc.title}`}
            title="Add child page"
            data-testid={`wiki-add-child-${node.doc.slug}`}
            onClick={(e) => { e.stopPropagation(); onAddChild(node.doc.id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="grid h-6 w-6 place-items-center rounded text-fg-3 opacity-0 transition-opacity duration-fast hover:bg-card hover:text-fg group-hover/row:opacity-100"
          >
            <Icon icon={Plus} size={14} />
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
              onAddChild={onAddChild}
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
