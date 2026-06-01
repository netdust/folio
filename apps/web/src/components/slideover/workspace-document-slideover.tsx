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
import { useEffect, useMemo, useRef, useState } from 'react';
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

  const close = () => {
    const { wdoc: _wdoc, ...next } = search;
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
          {slug ? <SlideoverBody wslug={wslug} slug={slug} mode={mode} tab={tab} /> : null}
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
  tab,
}: {
  wslug: string;
  slug: string;
  mode: EditorMode;
  tab: WorkspaceDocTabValue;
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
          <TriggerFieldsTabPane doc={doc} wslug={wslug} onPatch={onPatch} />
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
              frontmatter={doc.frontmatter}
              pinnedFields={[]}
              onStatusCommit={() => {
                /* no-op: agents have no status */
              }}
              onFrontmatterCommit={(p) => void onPatch({ frontmatter: p }, Object.keys(p))}
              pendingKeys={pendingKeys}
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
