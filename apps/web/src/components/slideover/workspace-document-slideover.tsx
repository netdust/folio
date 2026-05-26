/**
 * Phase 2.5: slideover for workspace-scoped documents (agents + triggers).
 *
 * Mirrors DocumentSlideover's URL-driven lifecycle (?doc=<slug> opens it) but
 * uses workspace-scoped hooks and skips project-specific surface: no status
 * field, no pinned fields, no activity panel, no log-activity, no copy-as-MD
 * (agents don't have a workspace-scoped .md endpoint yet).
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { MoreHorizontal, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import {
  useWorkspaceDocument,
  useUpdateWorkspaceDocument,
  useDeleteWorkspaceDocument,
} from '../../lib/api/workspace-documents.ts';
import type { Document } from '../../lib/api/documents.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { FrontmatterForm } from './frontmatter-form.tsx';
import { BodyEditor } from './body-editor.tsx';
import { ModeToggle, type EditorMode } from './mode-toggle.tsx';
import { RawMdEditor } from './raw-md-editor.tsx';

interface Props {
  wslug: string;
}

export function WorkspaceDocumentSlideover({ wslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { doc?: string };
  const open = !!search.doc;
  const slug = search.doc ?? null;
  const { data: doc, isLoading, error } = useWorkspaceDocument(wslug, slug);
  const [mode, setMode] = useState<EditorMode>('rich');
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteWorkspaceDocument(wslug);

  // Alt+M toggles raw ↔ rich, matching the project slideover's shortcut.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        setMode((m) => (m === 'rich' ? 'raw' : 'rich'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => {
    const { doc: _doc, ...next } = search;
    void navigate({ to: '.', search: next });
  };

  const onDelete = async () => {
    if (!doc) return;
    try {
      await del.mutateAsync(doc.slug);
      toast.success('Deleted');
      setConfirmDelete(false);
      close();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent width={800} className="h-screen">
        <SheetHeader>
          <SheetTitle>
            {isLoading ? (
              <Skeleton width={200} height={20} />
            ) : error ? (
              'Failed to load'
            ) : doc ? (
              // key={doc.id} forces remount when the user opens a different doc
              // without closing the slideover (e.g., create A → create B). Without
              // the key InlineEdit's `defaultEditing` only fires once.
              <SlideoverTitleEditor key={doc.id} doc={doc} wslug={wslug} />
            ) : (
              '—'
            )}
          </SheetTitle>
          <div data-testid="workspace-slideover-toolbar" className="flex items-center gap-1.5">
            {doc ? (
              <>
                <ModeToggle mode={mode} onChange={setMode} />
                <div aria-hidden className="mx-0.5 h-4 w-px bg-border-light" />
                <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="More actions"
                      className="grid h-6 w-6 place-items-center rounded text-fg-2 hover:bg-card hover:text-fg"
                    >
                      <Icon icon={MoreHorizontal} size={16} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="min-w-[160px] py-1">
                    <div role="menu" className="flex flex-col">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false);
                          setConfirmDelete(true);
                        }}
                        className="inline-flex items-center gap-2 px-3 py-1.5 text-left text-sm text-danger transition-colors duration-fast hover:bg-card"
                      >
                        <Icon icon={Trash2} size={14} />
                        Delete
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            ) : null}
            <IconButton label="Close document" onClick={close}>
              <Icon icon={X} size={16} />
            </IconButton>
          </div>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-hidden px-6 py-4">
          {slug ? <SlideoverBody wslug={wslug} slug={slug} mode={mode} /> : null}
        </div>
      </SheetContent>
      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => { if (!del.isPending) setConfirmDelete(o); }}
      >
        <DialogContent>
          <DialogTitle>Delete this document?</DialogTitle>
          <DialogDescription>
            {doc ? <>Delete &ldquo;{doc.title}&rdquo;? This cannot be undone.</> : null}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={del.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void onDelete()} disabled={del.isPending}>
              {del.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

function SlideoverTitleEditor({ doc, wslug }: { doc: Document; wslug: string }) {
  const update = useUpdateWorkspaceDocument(wslug);
  const onCommit = async (next: string) => {
    try {
      await update.mutateAsync({ slug: doc.slug, patch: { title: next } });
      // Workspace-scoped agents/triggers don't auto-regenerate slugs on title
      // change (see services/documents.ts: maybeRegenerateSlug gated on p),
      // so we don't need to sync ?doc= here.
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };
  return (
    <InlineEdit
      value={doc.title}
      onCommit={onCommit}
      ariaLabel={`Edit title: ${doc.title}`}
      defaultEditing={doc.title === 'Untitled'}
      className="text-base font-medium"
    />
  );
}

function SlideoverBody({
  wslug,
  slug,
  mode,
}: {
  wslug: string;
  slug: string;
  mode: EditorMode;
}) {
  const { data: doc, isLoading, error } = useWorkspaceDocument(wslug, slug);
  const update = useUpdateWorkspaceDocument(wslug);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

  if (isLoading) return <div className="text-fg-3">Loading document…</div>;
  if (error || !doc) return <div className="text-danger">Failed to load document.</div>;

  const onPatch = async (patch: Record<string, unknown>, keys: string[]) => {
    setPendingKeys((prev) => {
      const n = new Set(prev);
      keys.forEach((k) => n.add(k));
      return n;
    });
    try {
      await update.mutateAsync({ slug: doc.slug, patch });
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setPendingKeys((prev) => {
        const n = new Set(prev);
        keys.forEach((k) => n.delete(k));
        return n;
      });
    }
  };

  return (
    <article className="flex h-full flex-col">
      <header className="flex-shrink-0 space-y-3 pb-4">
        <div className="font-mono text-[11px] text-fg-3">/{doc.slug}</div>
        <FrontmatterForm
          wslug={wslug}
          // FrontmatterForm requires a pslug for the AssigneePicker branch; agents
          // and triggers don't carry an `assignee` field so the AssigneePicker
          // is never rendered. Empty string is safe.
          pslug=""
          type={doc.type}
          status={null}
          statuses={[]}
          frontmatter={doc.frontmatter}
          pinnedFields={[]}
          onStatusCommit={() => { /* no-op: agents/triggers have no status */ }}
          onFrontmatterCommit={(p) => void onPatch({ frontmatter: p }, Object.keys(p))}
          pendingKeys={pendingKeys}
        />
      </header>
      <div
        data-testid="workspace-slideover-editor"
        className="folio-scroll flex-1 min-h-0 overflow-y-auto border-t border-border-light pt-4 focus-within:border-fg-3"
      >
        {mode === 'rich' ? (
          <BodyEditor
            key={`rich-${doc.slug}`}
            value={doc.body}
            onChange={(body) => onPatch({ body }, ['body'])}
            documents={[]}
            aiConfigured={false}
            showToolbar={false}
          />
        ) : (
          <RawMdEditor
            key={`raw-${doc.slug}`}
            value={doc.body}
            onChange={(body) => onPatch({ body }, ['body'])}
          />
        )}
      </div>
    </article>
  );
}
