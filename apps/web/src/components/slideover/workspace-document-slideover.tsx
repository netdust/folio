/**
 * Phase 2.5: slideover for workspace-scoped documents (agents + triggers).
 *
 * Mirrors DocumentSlideover's URL-driven lifecycle but on its OWN param: the
 * workspace slideover opens on ?wdoc=<slug> (NOT ?doc=) so it never collides
 * with the project DocumentSlideover, which keeps ?doc=. Both mount under the
 * /w/$wslug layout; sharing one param made them stack as dual modals. `wdoc`
 * (workspace-doc) covers both agents AND triggers. It
 * uses workspace-scoped hooks and skips project-specific surface: no status
 * field, no pinned fields, no activity panel, no log-activity, no copy-as-MD
 * (agents don't have a workspace-scoped .md endpoint yet).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Bot, Check, Code, FileText, History, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { HeaderTabs, type HeaderTabItem } from './header-tabs.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import { ResizeHandle } from '../ui/resize-handle.tsx';
import { useResizableWidth } from '../../lib/use-resizable-width.ts';
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
import { type EditorMode } from './mode-toggle.tsx';
import { RawMdEditor } from './raw-md-editor.tsx';
import { WorkspaceActivityPanel } from './workspace-activity-panel.tsx';
import { WorkspaceLogActivityButton } from './workspace-log-activity-button.tsx';
import { TriggerForm } from '../triggers/trigger-form.tsx';
import { RunsHistorySection } from '../runs/runs-history-section.tsx';
import { useDocumentDraft } from '../../lib/use-document-draft.ts';
import { useUnsavedGuard } from '../../lib/use-unsaved-guard.ts';
import { SaveButton } from './save-button.tsx';

type WorkspaceDocTabValue = 'fields' | 'activity' | 'runs';

const WORKSPACE_DOC_TABS: readonly WorkspaceDocTabValue[] = ['fields', 'activity', 'runs'];

// The `?tab=` param is SHARED across this layout (settings: tokens|ai, the
// automation page: agents|triggers, this slideover: fields|activity|runs — see
// w.$wslug.tsx validateSearch). So `search.tab` may legitimately hold a value
// from a SIBLING surface. Opening an agent from /agents?tab=agents spreads
// `tab: 'agents'` into the URL alongside `wdoc=`; if we seeded the slideover
// tab from that raw value it'd be 'agents', which matches none of the render
// branches → a blank pane until the user clicks Fields. Narrow to our own enum,
// defaulting anything else to 'fields'.
function asWorkspaceDocTab(value: string | undefined): WorkspaceDocTabValue {
  return value && (WORKSPACE_DOC_TABS as readonly string[]).includes(value)
    ? (value as WorkspaceDocTabValue)
    : 'fields';
}

interface Props {
  wslug: string;
}

export function WorkspaceDocumentSlideover({ wslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { wdoc?: string; tab?: WorkspaceDocTabValue };
  const open = !!search.wdoc;
  const slug = search.wdoc ?? null;
  const { data: doc, isLoading, error } = useWorkspaceDocument(wslug, slug);
  const [mode, setMode] = useState<EditorMode>('rich');
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteWorkspaceDocument(wslug);
  const update = useUpdateWorkspaceDocument(wslug);
  // Draft is seeded from a stable fallback until the doc loads, then re-seeds on
  // doc.id/updatedAt (handled inside the hook). The fallback keeps hook order
  // stable across the loading→loaded transition.
  const draftDoc = doc ?? { id: '', updatedAt: '', body: '', frontmatter: {} };
  const { draft, setBody, setFrontmatter, isDirty, reset, diff } = useDocumentDraft(draftDoc);
  const guard = useUnsavedGuard(isDirty);

  const onSave = async () => {
    if (!doc) return;
    const { patch, keys } = diff();
    if (keys.length === 0) return;
    try {
      await update.mutateAsync({ slug: doc.slug, patch });
      toast.success('Saved');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };
  const { width, onDragStart } = useResizableWidth('agent-config', {
    default: 480,
    min: 360,
    max: 1100,
  });

  // Tab state lives here (not in SlideoverBody) so the icon toggles render
  // inline in the header — NocoDB-style single row. Defaults to Fields; a
  // ?tab= deep-link (e.g. the activity feed opening an agent's Runs tab) wins
  // ONCE, when a doc opens.
  const [tab, setTab] = useState<WorkspaceDocTabValue>(asWorkspaceDocTab(search.tab));
  // Re-seed the tab ONLY when a different doc opens — keyed on doc.id, NOT on
  // search.tab. Reading search.tab as an effect dep was a bug: selectTab strips
  // ?tab= on a manual click, which flips search.tab defined→undefined and
  // re-fired this effect, stomping the user's just-clicked tab back to Fields.
  // `searchRef` reads the CURRENT ?tab= at seed time without making it a dep.
  const searchRef = useRef(search);
  searchRef.current = search;
  const seededForDocRef = useRef<string | null>(null);
  useEffect(() => {
    if (doc?.id) {
      if (seededForDocRef.current !== doc.id) {
        seededForDocRef.current = doc.id;
        setTab(asWorkspaceDocTab(searchRef.current.tab));
      }
    } else {
      // Slideover closed (doc cleared). Reset the seed gate so REOPENING the
      // SAME doc with a fresh ?tab= deep-link re-seeds — the component is
      // mounted persistently at the layout, so without this the ref would keep
      // the last doc.id and a reopen-same-doc deep-link would be ignored.
      seededForDocRef.current = null;
    }
  }, [doc?.id]);
  // A MANUAL tab click updates state AND clears the ?tab= deep-link param so it
  // doesn't re-assert on a later doc switch. Clearing the param no longer
  // re-seeds the tab (the effect is doc.id-keyed), so the click sticks.
  const selectTab = (next: WorkspaceDocTabValue) => {
    setTab(next);
    if (search.tab !== undefined) {
      const { tab: _tab, ...rest } = search;
      void navigate({ to: '.', search: rest });
    }
  };
  const tabItems: HeaderTabItem<WorkspaceDocTabValue>[] = [
    { value: 'fields', label: 'Fields', icon: FileText },
    { value: 'activity', label: 'Activity', icon: History },
    { value: 'runs', label: 'Runs', icon: Bot },
  ];

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

  // Cmd/Ctrl-S saves the buffered draft when dirty.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (isDirty && !update.isPending) void onSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // onSave/isDirty captured fresh each render via the listener closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isDirty, update.isPending]);

  const doClose = () => {
    const { wdoc: _wdoc, ...next } = search;
    void navigate({ to: '.', search: next });
  };
  const close = () => guard.guard(doClose);

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
      <SheetContent width={width} className="h-screen">
        <ResizeHandle onDragStart={onDragStart} />
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
                <HeaderTabs value={tab} items={tabItems} onChange={selectTab} />
                <div aria-hidden className="mx-0.5 h-4 w-px bg-border-light" />
                <SaveButton dirty={isDirty} saving={update.isPending} onSave={() => void onSave()} />
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
                  <PopoverContent align="end" className="min-w-[180px] py-1">
                    <div role="menu" className="flex flex-col">
                      {/* Rich/Raw editor switch lives here (not the header) to
                          keep the narrow panel header uncramped. Only relevant
                          where the body editor renders: agents on Fields. */}
                      {tab === 'fields' && doc.type === 'agent' ? (
                        <>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={mode === 'rich'}
                            onClick={() => {
                              setMode('rich');
                              setMoreOpen(false);
                            }}
                            className="inline-flex items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-2 transition-colors duration-fast hover:bg-card hover:text-fg"
                          >
                            <Icon icon={Pencil} size={14} />
                            Edit (rich)
                            {mode === 'rich' ? <Icon icon={Check} size={14} className="ml-auto" /> : null}
                          </button>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={mode === 'raw'}
                            onClick={() => {
                              setMode('raw');
                              setMoreOpen(false);
                            }}
                            className="inline-flex items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-2 transition-colors duration-fast hover:bg-card hover:text-fg"
                          >
                            <Icon icon={Code} size={14} />
                            Raw markdown
                            {mode === 'raw' ? <Icon icon={Check} size={14} className="ml-auto" /> : null}
                          </button>
                          <div aria-hidden className="my-1 h-px bg-border-light" />
                        </>
                      ) : null}
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
          {slug && doc ? (
            <SlideoverBody
              doc={doc}
              wslug={wslug}
              mode={mode}
              tab={tab}
              draft={draft}
              setBody={setBody}
              setFrontmatter={setFrontmatter}
            />
          ) : null}
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
      <Dialog open={guard.prompting} onOpenChange={(o) => { if (!o) guard.cancel(); }}>
        <DialogContent>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            {doc ? <>You have unsaved edits to &ldquo;{doc.title}&rdquo;.</> : null}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => { reset(); guard.proceed(); }}
            >
              Discard
            </Button>
            <Button variant="secondary" onClick={() => guard.cancel()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={update.isPending}
              onClick={async () => { await onSave(); guard.proceed(); }}
            >
              {update.isPending ? 'Saving…' : 'Save'}
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
  doc,
  wslug,
  mode,
  tab,
  draft,
  setBody,
  setFrontmatter,
}: {
  doc: Document;
  wslug: string;
  mode: EditorMode;
  tab: WorkspaceDocTabValue;
  draft: { body: string; frontmatter: Record<string, unknown> };
  setBody: (body: string) => void;
  setFrontmatter: (patch: Record<string, unknown>) => void;
}) {
  return (
    <article className="flex h-full flex-col">
      <header className="flex-shrink-0 pb-2">
        <div className="font-mono text-[11px] text-fg-3">/{doc.slug}</div>
      </header>
      {/* FIELDS tab.
          • Triggers: a single full-height form — no Milkdown body editor, so
            the form fills the pane instead of being capped at 40vh above an
            empty editor area.
          • Agents: the frontmatter form (capped) sits ABOVE the body editor.
          ACTIVITY / RUNS tabs render a full-height panel with no editor. */}
      {tab === 'fields' && doc.type === 'trigger' ? (
        <div
          data-testid="workspace-slideover-tab-content"
          className="folio-scroll min-h-0 flex-1 overflow-y-auto pt-3"
        >
          <TriggerFieldsTabPane doc={doc} wslug={wslug} draft={draft} setBody={setBody} setFrontmatter={setFrontmatter} />
        </div>
      ) : null}
      {tab === 'fields' && doc.type !== 'trigger' ? (
        <>
          <div
            data-testid="workspace-slideover-tab-content"
            className="folio-scroll shrink-0 max-h-[40vh] overflow-y-auto pb-3 pt-3"
          >
            <FrontmatterForm
              wslug={wslug}
              // FrontmatterForm requires a pslug for the AssigneePicker branch;
              // agents don't carry an `assignee` field so the AssigneePicker is
              // never rendered. Empty string is safe.
              pslug=""
              type={doc.type}
              status={null}
              statuses={[]}
              frontmatter={draft.frontmatter}
              pinnedFields={[]}
              onStatusCommit={() => {
                /* no-op: agents have no status */
              }}
              onFrontmatterCommit={(p) => setFrontmatter(p)}
              pendingKeys={new Set()}
            />
          </div>
          <div
            data-testid="workspace-slideover-editor"
            className="folio-scroll flex-1 min-h-0 overflow-y-auto border-t border-border-light pt-4 focus-within:border-fg-3"
          >
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-fg-3">
              Prompt
            </div>
            {mode === 'rich' ? (
              <BodyEditor
                // Key on the seed identity (slug + updatedAt) so the editor
                // remounts onto the freshly-seeded draft body — both on a
                // doc-switch AND when the shared draft re-seeds after the parent
                // loads/saves the doc (BodyEditor only reads `value` at mount).
                key={`rich-${doc.slug}-${doc.updatedAt}`}
                value={draft.body}
                onChange={(body) => setBody(body)}
                documents={[]}
                aiConfigured={false}
                showToolbar={false}
              />
            ) : (
              <RawMdEditor
                key={`raw-${doc.slug}-${doc.updatedAt}`}
                value={draft.body}
                onChange={(body) => setBody(body)}
              />
            )}
          </div>
        </>
      ) : null}
      {tab === 'activity' ? (
        <div
          data-testid="workspace-slideover-tab-content"
          className="folio-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pt-3"
        >
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
        <div
          data-testid="workspace-slideover-tab-content"
          className="folio-scroll min-h-0 flex-1 overflow-y-auto pt-3"
        >
          {doc.type === 'agent' ? (
            <RunsHistorySection
              wslug={wslug}
              agentSlug={doc.slug}
              projects={(doc.frontmatter.projects as string[] | undefined) ?? ['*']}
            />
          ) : (
            <div className="text-fg-3 text-sm py-8 text-center">Runs apply to agents only.</div>
          )}
        </div>
      ) : null}
    </article>
  );
}

/**
 * D7 → unified-save: Fields tab pane for triggers. The local draft + inline Save
 * button were removed; the shared buffered draft (owned by the parent slideover)
 * now backs the form, and the header disk icon is the single Save affordance.
 * TriggerForm stays purely controlled — it emits the full frontmatter object on
 * every change, which the parent's shallow-merging `setFrontmatter` absorbs.
 *
 * Builtin-trigger read-only semantics cascade from D6 — TriggerForm disables
 * everything except the Enabled checkbox.
 */
function TriggerFieldsTabPane({
  doc,
  wslug,
  draft,
  setBody,
  setFrontmatter,
}: {
  doc: Document;
  wslug: string;
  draft: { body: string; frontmatter: Record<string, unknown> };
  setBody: (body: string) => void;
  setFrontmatter: (patch: Record<string, unknown>) => void;
}) {
  return (
    <TriggerForm
      value={{ title: doc.title, body: draft.body, frontmatter: draft.frontmatter }}
      onChange={(next) => {
        // Title auto-commits via InlineEdit — ignore next.title here.
        if (next.body !== draft.body) setBody(next.body);
        // TriggerForm emits the full frontmatter object each change; the shallow
        // merge reflects key drops too (e.g. schedule→event nulls `schedule`).
        setFrontmatter(next.frontmatter);
      }}
      workspaceSlug={wslug}
    />
  );
}
