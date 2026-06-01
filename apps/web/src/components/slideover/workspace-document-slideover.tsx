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
 *
 * unified-document-save: the buffered draft (useDocumentDraft) seeds ONCE per
 * mount and never re-seeds in place. So the PARENT keeps only the Sheet shell +
 * the loading/error states + tab state + the close/switch guard; everything that
 * READS the draft (the draft itself, the body, onSave, the Cmd-S shortcut) lives
 * in a KEYED inner component (WorkspaceSlideoverInner) mounted only once a REAL
 * doc exists, keyed on `${doc.id}:${doc.updatedAt}`. A doc switch or a post-save
 * version bump remounts the inner → a fresh clean seed, no in-place re-seed, no
 * oscillation against React Query's refetch toggling.
 *
 * The Save button reads the draft's dirtiness, so the inner reports `isDirty` up
 * via onDirtyChange and exposes imperative save/discard via an actions ref; the
 * parent renders the header Save button (off the mirrored dirty flag) and drives
 * the unsaved-changes dialog through those imperative handles.
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
import { SaveButton } from './save-button.tsx';

type WorkspaceDocTabValue = 'fields' | 'activity' | 'runs';

const WORKSPACE_DOC_TABS: readonly WorkspaceDocTabValue[] = ['fields', 'activity', 'runs'];

interface InnerActions {
  save: () => Promise<void>;
  discard: () => void;
}

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

  // Dirtiness is OWNED by the keyed inner (which owns the draft) and MIRRORED up
  // here so the parent's header Save button + close/switch guard can read it.
  // The inner reports via onDirtyChange; imperative save/discard come back via
  // the actions ref so the unsaved-changes dialog can drive them.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const actionsRef = useRef<InnerActions | null>(null);

  const { width, onDragStart } = useResizableWidth('agent-config', {
    default: 480,
    min: 360,
    max: 1100,
  });

  // Tab state lives here (not in the inner) so the icon toggles render inline in
  // the header — NocoDB-style single row — AND so a tab switch doesn't remount
  // the draft-owning inner. Defaults to Fields; a ?tab= deep-link (e.g. the
  // activity feed opening an agent's Runs tab) wins ONCE, when a doc opens.
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

  // ----- close + doc-switch guard ------------------------------------------
  // Because the inner remounts on a doc switch (clearing its own isDirty before
  // any effect could observe it), we LATCH the slug whose buffer was dirty so the
  // switch still routes through the prompt. The latch is set whenever the inner
  // reports dirty, released when it reports clean for the loaded doc.
  const dirtySlugRef = useRef<string | null>(null);
  if (doc?.slug && dirty) dirtySlugRef.current = doc.slug;
  else if (doc?.slug && doc.slug === dirtySlugRef.current && !dirty) dirtySlugRef.current = null;

  // Local guard (replaces useUnsavedGuard): if dirty, defer the action and prompt.
  const [prompting, setPrompting] = useState(false);
  const queuedRef = useRef<(() => void) | null>(null);
  const guard = (action: () => void) => {
    if (!dirty && dirtySlugRef.current === null) {
      action();
      return;
    }
    queuedRef.current = action;
    setPrompting(true);
  };
  const proceed = () => {
    const action = queuedRef.current;
    queuedRef.current = null;
    setPrompting(false);
    action?.();
  };
  const cancelPrompt = () => {
    queuedRef.current = null;
    setPrompting(false);
  };

  const doClose = () => {
    const { wdoc: _wdoc, ...next } = search;
    void navigate({ to: '.', search: next });
  };
  const close = () => guard(doClose);

  // Guard doc-SWITCH (not just close): if the URL wdoc flips to a DIFFERENT slug
  // while the buffer is dirty, intercept — revert the URL to the latched (still
  // dirty) doc and prompt. The guard's queued action re-applies the intended
  // switch once the buffer is resolved (Save remounts the inner clean, Discard
  // resets it).
  //
  // Detection runs DURING render (not in a [search.wdoc] effect): switching wdoc
  // unloads the old doc and remounts the inner clean, so by the time an effect
  // fires both `dirty` AND the loaded slug have already moved on. Comparing the
  // committed wdoc to the previous one during render catches the flip while
  // dirtySlugRef still names the dirty doc.
  const prevWdocRef = useRef<string | undefined>(search.wdoc);
  const pendingSwitchRef = useRef<string | null>(null);
  if (prevWdocRef.current !== search.wdoc) {
    const incoming = search.wdoc;
    const dirtySlug = dirtySlugRef.current;
    if (incoming && dirtySlug && incoming !== dirtySlug) {
      pendingSwitchRef.current = incoming;
    }
    prevWdocRef.current = incoming;
  }
  useEffect(() => {
    const incoming = pendingSwitchRef.current;
    const dirtySlug = dirtySlugRef.current;
    pendingSwitchRef.current = null;
    if (!incoming || !dirtySlug || incoming === dirtySlug) return;
    // Revert URL to the dirty doc and queue the intended switch behind the guard.
    void navigate({ to: '.', search: { ...search, wdoc: dirtySlug } });
    guard(() => navigate({ to: '.', search: { ...search, wdoc: incoming } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.wdoc]);

  // Cmd/Ctrl-S saves the buffered draft when dirty (delegates to the inner).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (dirty && !saving) void actionsRef.current?.save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dirty, saving]);

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

  // Shared key — the crux of the refetch-stomp fix: a doc switch OR a post-save
  // updatedAt bump remounts the inner → a fresh useDocumentDraft seed from the
  // loaded doc. No in-place re-seed, no oscillation. The inner is null until a
  // REAL doc loads, so it never sees the loading placeholder.
  const innerKey = doc ? `${doc.id}:${doc.updatedAt}` : null;

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
                {/* Save reads the buffered draft (owned by the inner) — render it
                    off the mirrored dirty flag; the click delegates to the inner. */}
                <SaveButton dirty={dirty} saving={saving} onSave={() => void actionsRef.current?.save()} />
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
          {slug && doc && innerKey ? (
            <WorkspaceSlideoverInner
              key={innerKey}
              doc={doc}
              wslug={wslug}
              mode={mode}
              tab={tab}
              onDirtyChange={setDirty}
              onSavingChange={setSaving}
              actionsRef={actionsRef}
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
      <Dialog open={prompting} onOpenChange={(o) => { if (!o) cancelPrompt(); }}>
        <DialogContent>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>
            {doc ? <>You have unsaved edits to &ldquo;{doc.title}&rdquo;.</> : null}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => { actionsRef.current?.discard(); proceed(); }}
            >
              Discard
            </Button>
            <Button variant="secondary" onClick={() => cancelPrompt()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={saving}
              onClick={async () => { await actionsRef.current?.save(); proceed(); }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

/**
 * Owns the buffered draft (useDocumentDraft) + the body + onSave. Mounted only
 * when a REAL doc is loaded, KEYED on `${doc.id}:${doc.updatedAt}` by the parent
 * — so a doc switch or a post-save version bump remounts it and re-seeds the
 * draft cleanly (no in-place re-seed, no oscillation).
 *
 * It mirrors dirtiness + saving state up to the parent (which renders the header
 * Save button + the unsaved-changes dialog) and exposes imperative save/discard
 * via the actions ref so the dialog can drive them.
 */
function WorkspaceSlideoverInner({
  doc,
  wslug,
  mode,
  tab,
  onDirtyChange,
  onSavingChange,
  actionsRef,
}: {
  doc: Document;
  wslug: string;
  mode: EditorMode;
  tab: WorkspaceDocTabValue;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  actionsRef: React.MutableRefObject<InnerActions | null>;
}) {
  const update = useUpdateWorkspaceDocument(wslug);
  const { draft, setBody, setFrontmatter, isDirty, reset, diff } = useDocumentDraft(doc);

  const onSave = async () => {
    const { patch, keys } = diff();
    if (keys.length === 0) return;
    try {
      await update.mutateAsync({ slug: doc.slug, patch });
      toast.success('Saved');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // Publish dirtiness up so the parent's Save button + guard can read it.
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  // Publish saving state up so the parent's Save button shows a spinner.
  useEffect(() => {
    onSavingChange(update.isPending);
  }, [update.isPending, onSavingChange]);

  // Expose imperative save/discard so the parent's unsaved-changes dialog + the
  // Cmd-S shortcut can drive them. `reset` discards the buffer; `onSave` persists.
  actionsRef.current = { save: onSave, discard: reset };

  return (
    <SlideoverBody
      doc={doc}
      wslug={wslug}
      mode={mode}
      tab={tab}
      draft={draft}
      setBody={setBody}
      setFrontmatter={setFrontmatter}
    />
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
                // The inner remounts on doc.id/updatedAt, so the body editor
                // remounts onto the freshly-seeded draft body with it. The
                // mode-scoped key still flips rich↔raw without remounting on a
                // toggle.
                key={`rich-${doc.slug}`}
                value={draft.body}
                onChange={(body) => setBody(body)}
                documents={[]}
                aiConfigured={false}
                showToolbar={false}
              />
            ) : (
              <RawMdEditor
                key={`raw-${doc.slug}`}
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
 * button were removed; the shared buffered draft (owned by the inner slideover)
 * now backs the form, and the header disk icon is the single Save affordance.
 * TriggerForm stays purely controlled — it emits the full frontmatter object on
 * every change, which the inner's shallow-merging `setFrontmatter` absorbs.
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
