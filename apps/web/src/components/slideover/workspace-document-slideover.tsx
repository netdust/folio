/**
 * Phase 2.5: slideover for workspace-scoped documents (agents + triggers).
 *
 * Mirrors DocumentSlideover's URL-driven lifecycle (?doc=<slug> opens it) but
 * uses workspace-scoped hooks and skips project-specific surface: no status
 * field, no pinned fields, no activity panel, no log-activity, no copy-as-MD
 * (agents don't have a workspace-scoped .md endpoint yet).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { MoreHorizontal, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { TabStrip, type TabItem } from '../ui/tab-strip.tsx';
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
import { WorkspaceActivityPanel } from './workspace-activity-panel.tsx';
import { WorkspaceLogActivityButton } from './workspace-log-activity-button.tsx';
import { TriggerForm } from '../triggers/trigger-form.tsx';
import { RunsHistorySection } from '../runs/runs-history-section.tsx';

type WorkspaceDocTabValue = 'fields' | 'activity' | 'runs';

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

  // Tab state — per-slideover-open. Defaults to Fields on each fresh open
  // and resets to Fields whenever the user navigates to a different doc.
  const [tab, setTab] = useState<WorkspaceDocTabValue>('fields');
  useEffect(() => {
    setTab('fields');
  }, [doc?.id]);

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

  const tabItems: TabItem<WorkspaceDocTabValue>[] = [
    { value: 'fields', label: 'Fields', icon: '📋' },
    { value: 'activity', label: 'Activity', icon: '📜' },
    { value: 'runs', label: 'Runs', icon: '🤖' },
  ];

  return (
    <article className="flex h-full flex-col">
      <header className="flex-shrink-0 pb-2">
        <div className="font-mono text-[11px] text-fg-3">/{doc.slug}</div>
      </header>
      <TabStrip value={tab} items={tabItems} onChange={setTab} />
      <div
        data-testid="workspace-slideover-tab-content"
        className="folio-scroll shrink-0 max-h-[40vh] overflow-y-auto pb-3 pt-3"
      >
        {tab === 'fields' ? (
          doc.type === 'trigger' ? (
            <TriggerFieldsTabPane
              doc={doc}
              wslug={wslug}
              onPatch={onPatch}
            />
          ) : (
            <FrontmatterForm
              wslug={wslug}
              // FrontmatterForm requires a pslug for the AssigneePicker branch;
              // agents and triggers don't carry an `assignee` field so the
              // AssigneePicker is never rendered. Empty string is safe.
              pslug=""
              type={doc.type}
              status={null}
              statuses={[]}
              frontmatter={doc.frontmatter}
              pinnedFields={[]}
              onStatusCommit={() => {
                /* no-op: agents/triggers have no status */
              }}
              onFrontmatterCommit={(p) => void onPatch({ frontmatter: p }, Object.keys(p))}
              pendingKeys={pendingKeys}
            />
          )
        ) : null}
        {tab === 'activity' ? (
          <div className="flex flex-col gap-2">
            {/* Log button only on agents — A7 rejects type=trigger with
                INVALID_ACTIVITY_TARGET, so triggers stay read-only here. */}
            {doc.type === 'agent' ? (
              <div className="flex justify-end">
                <WorkspaceLogActivityButton wslug={wslug} slug={doc.slug} />
              </div>
            ) : null}
            <WorkspaceActivityPanel wslug={wslug} slug={doc.slug} />
          </div>
        ) : null}
        {tab === 'runs' ? (
          doc.type === 'agent' ? (
            <RunsHistorySection
              wslug={wslug}
              agentSlug={doc.slug}
              projects={(doc.frontmatter.projects as string[] | undefined) ?? ['*']}
            />
          ) : (
            <div className="text-fg-3 text-sm py-8 text-center">Runs apply to agents only.</div>
          )
        ) : null}
      </div>
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

/**
 * D7: Fields tab pane for triggers. Wraps `<TriggerForm />` in a local draft
 * + Save button. TriggerForm fires onChange on every keystroke; we don't want
 * to PATCH on each — too many interlocked fields, and the JSON-payload editor
 * would spam the server with intermediate states. Instead, drafts accumulate
 * locally and Save diffs against the doc to send only changed top-level fields
 * (title / body / frontmatter).
 *
 * Builtin-trigger read-only semantics cascade from D6 — TriggerForm disables
 * everything except the Enabled checkbox. The wrapping Save button enables
 * once any field differs from the loaded doc.
 */
function TriggerFieldsTabPane({
  doc,
  wslug,
  onPatch,
}: {
  doc: Document;
  wslug: string;
  onPatch: (patch: Record<string, unknown>, keys: string[]) => void;
}) {
  const initial = useMemo(
    () => ({
      title: doc.title,
      body: doc.body,
      frontmatter: doc.frontmatter,
    }),
    [doc.title, doc.body, doc.frontmatter],
  );

  const [draft, setDraft] = useState(initial);

  // Reset draft when the loaded doc changes (e.g. user navigates to a
  // different trigger without closing the slideover).
  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const isDirty = useMemo(() => {
    return (
      draft.title !== initial.title ||
      draft.body !== initial.body ||
      JSON.stringify(draft.frontmatter) !== JSON.stringify(initial.frontmatter)
    );
  }, [draft, initial]);

  const onSave = () => {
    const patch: Record<string, unknown> = {};
    const keys: string[] = [];
    if (draft.title !== initial.title) {
      patch.title = draft.title;
      keys.push('title');
    }
    if (draft.body !== initial.body) {
      patch.body = draft.body;
      keys.push('body');
    }
    if (JSON.stringify(draft.frontmatter) !== JSON.stringify(initial.frontmatter)) {
      patch.frontmatter = draft.frontmatter;
      // Diff frontmatter keys so the slideover's pending-UI state tracks only
      // what actually changed (a bulk frontmatter PATCH would otherwise pulse
      // every key).
      const oldFm = initial.frontmatter as Record<string, unknown>;
      const newFm = draft.frontmatter as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);
      for (const k of allKeys) {
        if (JSON.stringify(oldFm[k]) !== JSON.stringify(newFm[k])) keys.push(k);
      }
    }
    if (keys.length === 0) return;
    onPatch(patch, keys);
  };

  return (
    <div className="flex flex-col gap-3">
      <TriggerForm value={draft} onChange={setDraft} workspaceSlug={wslug} />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSave}
          disabled={!isDirty}
          className="rounded-md bg-fg text-bg px-3 py-1.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Save
        </button>
      </div>
    </div>
  );
}
