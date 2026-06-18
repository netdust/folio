import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  Bot,
  Check,
  Code,
  FileText,
  History,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
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
import { toast } from 'sonner';
import type { Document } from '../../lib/api/documents.ts';
import { formatApiError } from '../../lib/api/index.ts';
import {
  useDeleteWorkspaceDocument,
  useUpdateWorkspaceDocument,
  useWorkspaceDocument,
  workspaceDocumentsKeys,
} from '../../lib/api/workspace-documents.ts';
import { DEFAULT_TABLE_SLUG } from '../../lib/default-table.ts';
import { useDocumentDraft } from '../../lib/use-document-draft.ts';
import { useLiveDocument } from '../../lib/use-live-document.ts';
import { useResizableWidth } from '../../lib/use-resizable-width.ts';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { RunsHistorySection } from '../runs/runs-history-section.tsx';
import { TriggerForm } from '../triggers/trigger-form.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { ResizeHandle } from '../ui/resize-handle.tsx';
import { BodyEditor } from './body-editor.tsx';
import { ExternalUpdateBanner } from './external-update-banner.tsx';
import { FrontmatterForm } from './frontmatter-form.tsx';
import { type HeaderTabItem, HeaderTabs } from './header-tabs.tsx';
import type { EditorMode } from './mode-toggle.tsx';
import { RawMdEditor } from './raw-md-editor.tsx';
import { SaveButton } from './save-button.tsx';
import { SlideoverShell } from './slideover-shell.tsx';
import { type InnerActions, useSlideoverLifecycle } from './use-slideover-lifecycle.ts';
import { WorkspaceActivityPanel } from './workspace-activity-panel.tsx';
import { WorkspaceLogActivityButton } from './workspace-log-activity-button.tsx';

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
  const slug = search.wdoc ?? null;
  const { data: doc, isLoading, error } = useWorkspaceDocument(wslug, slug);
  const {
    open,
    dirty,
    setDirty,
    saving,
    setSaving,
    actionsRef,
    innerKey,
    prompting,
    proceed,
    cancelPrompt,
    close,
  } = useSlideoverLifecycle({ doc, paramKey: 'wdoc' });

  const [mode, setMode] = useState<EditorMode>('rich');
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteWorkspaceDocument(wslug);

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
    <SlideoverShell
      doc={doc}
      isLoading={isLoading}
      error={error}
      open={open}
      width={width}
      resizeHandle={<ResizeHandle onDragStart={onDragStart} />}
      toolbarTestId="workspace-slideover-toolbar"
      close={close}
      saving={saving}
      prompting={prompting}
      proceed={proceed}
      cancelPrompt={cancelPrompt}
      actionsRef={actionsRef}
      confirmDelete={confirmDelete}
      setConfirmDelete={setConfirmDelete}
      deletePending={del.isPending}
      onDelete={() => void onDelete()}
      title={
        // key={doc.id} forces remount when the user opens a different doc
        // without closing the slideover (e.g., create A → create B). Without
        // the key InlineEdit's `defaultEditing` only fires once.
        doc ? (
          <div className="flex min-w-0 items-center gap-1.5">
            {doc.type === 'trigger' &&
            (doc.frontmatter as { builtin?: boolean }).builtin === true ? (
              <Icon icon={Lock} size={14} className="text-fg-3" label="Builtin trigger — locked" />
            ) : null}
            <SlideoverTitleEditor key={doc.id} doc={doc} wslug={wslug} />
          </div>
        ) : null
      }
      toolbar={
        doc ? (
          <>
            <HeaderTabs value={tab} items={tabItems} onChange={selectTab} />
            <div aria-hidden className="mx-0.5 h-4 w-px bg-border-light" />
            {/* Save reads the buffered draft (owned by the inner) — render it
                off the mirrored dirty flag; the click delegates to the inner. */}
            <SaveButton
              dirty={dirty}
              saving={saving}
              onSave={() => void actionsRef.current?.save()}
            />
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
                        {mode === 'rich' ? (
                          <Icon icon={Check} size={14} className="ml-auto" />
                        ) : null}
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
                        {mode === 'raw' ? (
                          <Icon icon={Check} size={14} className="ml-auto" />
                        ) : null}
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
        ) : null
      }
      inner={
        slug && doc && innerKey ? (
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
        ) : null
      }
    />
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
  const qc = useQueryClient();
  const { draft, setBody, setFrontmatter, isDirty, reset, diff } = useDocumentDraft(doc);

  // Live external-update awareness (notify-don't-stomp): a clean draft pulls
  // server truth on a remote document.updated; a DIRTY draft shows a banner and
  // is NEVER refetched (would overwrite unsaved typing). Deletions always banner.
  const { externalUpdate, dismiss } = useLiveDocument({
    wslug,
    docId: doc.id,
    isDirty,
    onRefetch: () =>
      qc.invalidateQueries({ queryKey: workspaceDocumentsKeys.detail(wslug, doc.slug) }),
  });

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
    <div className="flex h-full flex-col">
      {externalUpdate && (
        <ExternalUpdateBanner
          update={externalUpdate}
          onDismiss={dismiss}
          onReload={() => {
            dismiss();
            reset();
            void qc.invalidateQueries({ queryKey: workspaceDocumentsKeys.detail(wslug, doc.slug) });
          }}
        />
      )}
      <div className="min-h-0 flex-1">
        <SlideoverBody
          doc={doc}
          wslug={wslug}
          mode={mode}
          tab={tab}
          draft={draft}
          setBody={setBody}
          setFrontmatter={setFrontmatter}
        />
      </div>
    </div>
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
          <TriggerFieldsTabPane
            doc={doc}
            wslug={wslug}
            draft={draft}
            setBody={setBody}
            setFrontmatter={setFrontmatter}
          />
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
              // Workspace slideover hosts agents/triggers (no project, no table).
              // Their relation candidate query is inert here (no docSlug-gated
              // relation field), and agents/triggers are project-scoped server-side
              // — so DEFAULT_TABLE_SLUG is the honest constant, same as pslug="".
              tslug={DEFAULT_TABLE_SLUG}
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
