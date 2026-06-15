import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Clipboard, FileText, History, MessageCircle, MoreHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useMe } from '../../lib/api/auth.ts';
import { useComments } from '../../lib/api/comments.ts';
import {
  type Document,
  type DocumentListParams,
  clausesToListParams,
  parseFilters,
  useDeleteDocument,
  useDocument,
  useDocuments,
  useUpdateDocument,
} from '../../lib/api/documents.ts';
import { documentsKeys } from '../../lib/api/documents.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useMembers } from '../../lib/api/members.ts';
import { useProject } from '../../lib/api/projects.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useWorkspace } from '../../lib/api/workspaces.ts';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { useCurrentTslug } from '../../lib/default-table.ts';
import { useDocumentDraft } from '../../lib/use-document-draft.ts';
import { useLiveDocument } from '../../lib/use-live-document.ts';
import { CommentsTab } from '../comments/comments-tab.tsx';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { ActivityPanel } from './activity-panel.tsx';
import { BodyEditor } from './body-editor.tsx';
import { ExternalUpdateBanner } from './external-update-banner.tsx';
import { FrontmatterForm } from './frontmatter-form.tsx';
import { type HeaderTabItem, HeaderTabs } from './header-tabs.tsx';
import { LogActivityButton } from './log-activity-button.tsx';
import { type EditorMode, ModeToggle } from './mode-toggle.tsx';
import { RawMdEditor } from './raw-md-editor.tsx';
import { SaveButton } from './save-button.tsx';
import { SlideoverShell } from './slideover-shell.tsx';
import { type InnerActions, useSlideoverLifecycle } from './use-slideover-lifecycle.ts';

type DocTabValue = 'fields' | 'comments' | 'activity';

interface Props {
  wslug: string;
  pslug: string;
}

/**
 * unified-document-save: the buffered draft (useDocumentDraft) seeds ONCE per
 * mount and never re-seeds in place. So the PARENT keeps only the Sheet shell +
 * loading/error states + tab/mode state + the close/switch guard + delete +
 * copy-as-MD; everything that READS the draft (the draft itself, the body,
 * onSave, onStatusCommit) lives in a KEYED inner (DocumentSlideoverInner)
 * mounted only once a REAL doc exists, keyed on `${doc.id}:${doc.updatedAt}`. A
 * doc switch or a post-save version bump remounts the inner → a fresh clean
 * seed, no in-place re-seed, no oscillation against React Query's refetch
 * toggling.
 *
 * Dirtiness + saving state mirror up so the parent can render the header Save
 * button + drive the unsaved-changes dialog through the inner's imperative
 * save/discard (actions ref).
 */
export function DocumentSlideover({ wslug, pslug }: Props) {
  // THE single table source for the whole slideover subtree (avoid a prop-vs-hook
  // split-brain): resolve once here and thread it as a prop down to the inner /
  // body / frontmatter-form / title editor. The slideover is a route-context leaf
  // keyed off the URL `?doc=`; useCurrentTslug returns the :tslug param under a
  // /t/:tslug route, else DEFAULT_TABLE_SLUG (the project-base / work-items view).
  const tslug = useCurrentTslug();
  const search = useSearch({ strict: false }) as { doc?: string };
  const slug = search.doc ?? null;
  const { data: doc, isLoading, error } = useDocument(wslug, pslug, slug);
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
  } = useSlideoverLifecycle({ doc, paramKey: 'doc' });

  const [mode, setMode] = useState<EditorMode>('rich');
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteDocument(wslug, pslug, tslug);

  // Tab state lives here (not in the inner) so the icon toggles render inline in
  // the header — NocoDB-style single row — AND so a tab switch doesn't remount
  // the draft-owning inner. Resets to Fields whenever a different doc opens.
  const [tab, setTab] = useState<DocTabValue>('fields');
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally resets to Fields ONLY when a different doc opens ([doc?.id]); setTab is a stable setter
  useEffect(() => {
    setTab('fields');
  }, [doc?.id]);
  // Comment count drives the Comments-tab badge (HeaderTabs renders it when >0).
  // Gated on doc.slug so it idles until the doc resolves. Pass the SAME default
  // visibility (['normal']) that CommentsTab uses with the toggle off, so this
  // query shares CommentsTab's react-query key (a cache hit, not a second
  // fetch) AND the badge count matches the rows the tab renders.
  const commentCount =
    useComments(wslug, pslug, doc?.slug ?? '', { visibility: ['normal'] }).data?.length ?? 0;
  const tabItems: HeaderTabItem<DocTabValue>[] = [
    { value: 'fields', label: 'Fields', icon: FileText },
    { value: 'comments', label: 'Comments', icon: MessageCircle, count: commentCount },
    { value: 'activity', label: 'Activity', icon: History },
  ];

  // Alt+M toggles raw ↔ rich. Window listener stays at this level so the
  // shortcut works regardless of where focus lives inside the slideover.
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

  const onCopyMd = async () => {
    if (!slug) return;
    try {
      await copyDocumentAsMarkdown(wslug, pslug, slug);
      toast.success('Copied as Markdown');
    } catch (err) {
      toast.error(formatApiError(err));
    }
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
    <SlideoverShell
      doc={doc}
      isLoading={isLoading}
      error={error}
      open={open}
      width={800}
      toolbarTestId="slideover-toolbar"
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
        // key={doc.id} forces a remount when the user opens a different
        // doc without closing the slideover (e.g., create A → Cmd-K → create
        // B). InlineEdit reads `defaultEditing` once at mount, so without
        // the key the second freshly-created "Untitled" wouldn't auto-edit.
        doc ? (
          <SlideoverTitleEditor key={doc.id} doc={doc} wslug={wslug} pslug={pslug} tslug={tslug} />
        ) : null
      }
      toolbar={
        doc ? (
          <>
            <HeaderTabs value={tab} items={tabItems} onChange={setTab} />
            <div aria-hidden className="mx-0.5 h-4 w-px bg-border-light" />
            <Button
              variant="secondary"
              size="sm"
              onClick={onCopyMd}
              className="inline-flex items-center gap-1.5"
            >
              <Icon icon={Clipboard} size={14} />
              Copy MD
            </Button>
            {/* Rich/Raw toggle only where the body editor renders (Fields). */}
            {tab === 'fields' ? <ModeToggle mode={mode} onChange={setMode} /> : null}
            <LogActivityButton wslug={wslug} pslug={pslug} slug={doc.slug} />
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
                  data-testid="slideover-more-actions"
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
        ) : null
      }
      inner={
        slug && doc && innerKey ? (
          <DocumentSlideoverInner
            key={innerKey}
            doc={doc}
            wslug={wslug}
            pslug={pslug}
            tslug={tslug}
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

// Match the open table's cache key so optimistic title/status updates land in
// the same listParams bucket the user is looking at. TableView builds its key
// from the same URL search params (status, sort, dir, etc.).
function useUrlDerivedListParams(docType: Document['type']): DocumentListParams {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return useMemo(() => {
    const clauses = parseFilters(search);
    const base = clausesToListParams(clauses);
    base.type = docType;
    const sortKey = typeof search.sort === 'string' ? search.sort : null;
    const sortDir = typeof search.dir === 'string' ? search.dir : null;
    if (sortKey) {
      base.sort = sortKey;
      base.dir = sortDir === 'desc' ? 'desc' : 'asc';
    } else {
      base.sort = 'updated_at';
      base.dir = 'desc';
    }
    return base;
  }, [search, docType]);
}

/**
 * Owns the buffered draft (useDocumentDraft) + the body + onSave + the immediate
 * status commit. Mounted only when a REAL doc is loaded, KEYED on
 * `${doc.id}:${doc.updatedAt}` by the parent — so a doc switch or a post-save
 * version bump remounts it and re-seeds the draft cleanly (no in-place re-seed,
 * no oscillation).
 *
 * It mirrors dirtiness + saving up to the parent (which renders the header Save
 * button + the unsaved-changes dialog) and exposes imperative save/discard via
 * the actions ref so the dialog can drive them.
 */
function DocumentSlideoverInner({
  doc,
  wslug,
  pslug,
  tslug,
  mode,
  tab,
  onDirtyChange,
  onSavingChange,
  actionsRef,
}: {
  doc: Document;
  wslug: string;
  pslug: string;
  tslug: string;
  mode: EditorMode;
  tab: DocTabValue;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  actionsRef: React.MutableRefObject<InnerActions | null>;
}) {
  const listParams = useUrlDerivedListParams(doc.type);
  const update = useUpdateDocument(wslug, pslug, tslug, listParams);
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
      qc.invalidateQueries({ queryKey: documentsKeys.detail(wslug, pslug, doc.slug) }),
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

  // Status stays IMMEDIATE-commit (NOT buffered) — it's a single-click field, not
  // a long-form edit. FrontmatterForm reads status from doc.status (server truth).
  const onStatusCommit = async (next: string) => {
    try {
      await update.mutateAsync({ slug: doc.slug, patch: { status: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => {
    onSavingChange(update.isPending);
  }, [update.isPending, onSavingChange]);

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
            void qc.invalidateQueries({ queryKey: documentsKeys.detail(wslug, pslug, doc.slug) });
          }}
        />
      )}
      <div className="min-h-0 flex-1">
        <SlideoverBody
          doc={doc}
          wslug={wslug}
          pslug={pslug}
          tslug={tslug}
          mode={mode}
          tab={tab}
          draft={draft}
          setBody={setBody}
          setFrontmatter={setFrontmatter}
          onStatusCommit={(next) => void onStatusCommit(next)}
        />
      </div>
    </div>
  );
}

function SlideoverTitleEditor({
  doc,
  wslug,
  pslug,
  tslug,
}: { doc: Document; wslug: string; pslug: string; tslug: string }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const listParams = useUrlDerivedListParams(doc.type);
  const update = useUpdateDocument(wslug, pslug, tslug, listParams);
  const onCommit = async (next: string) => {
    try {
      const updated = await update.mutateAsync({ slug: doc.slug, patch: { title: next } });
      // Server may have regenerated the slug from the new title. Sync the
      // slideover's ?doc= param so closing+reopening points at the real doc.
      if (updated?.slug && updated.slug !== doc.slug) {
        void navigate({ to: '.', search: { ...search, doc: updated.slug }, replace: true });
      }
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
  pslug,
  tslug,
  mode,
  tab,
  draft,
  setBody,
  setFrontmatter,
  onStatusCommit,
}: {
  doc: Document;
  wslug: string;
  pslug: string;
  tslug: string;
  mode: EditorMode;
  tab: DocTabValue;
  draft: { body: string; frontmatter: Record<string, unknown> };
  setBody: (body: string) => void;
  setFrontmatter: (patch: Record<string, unknown>) => void;
  onStatusCommit: (next: string) => void;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { data: statuses } = useStatuses(wslug, pslug, tslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const listParams = useUrlDerivedListParams(doc.type);
  // Documents list — same listParams as the inner's useUpdateDocument so React
  // Query dedupes the key. Feeds the body editor's slash-menu document links.
  // Current-table-scoped for work_items (the accepted v1 relation limitation —
  // no project-wide cross-table document endpoint exists).
  const { data: docPage } = useDocuments(wslug, pslug, tslug, listParams, { enabled: true });
  const { data: workspace } = useWorkspace(wslug);
  const { data: project } = useProject(wslug, pslug);

  // Comments + members + current user — for the Comments tab (work_item/page
  // only). The hook is gated on doc.slug so it idles until the doc resolves.
  const { data: members } = useMembers(wslug);
  const { data: me } = useMe();

  // AI key presence — drives the slash menu's aiConfigured flag. AI keys are
  // instance-level now; presence is a boot-identity boolean on /me, readable by
  // every member (the key LIST is admin-gated, but "is an LLM reachable" is not).
  const aiConfigured = me?.ai_configured ?? false;

  // Wiki pages are "just a markdown file" — no status, no pinned fields,
  // no inferred frontmatter, no slug pill. Work items keep the full
  // frontmatter form on the Fields tab. The body editor renders ONLY on the
  // Fields tab (Comments/Activity are full-height panels).
  const isPage = doc.type === 'page';

  return (
    <article className="flex h-full flex-col">
      {/* For work_items we keep a tiny header that only carries the slug
          pill. Pages don't carry a slug pill (Stefan's "wiki = .md file
          without frontmatter" rule). */}
      {!isPage ? (
        <header className="flex-shrink-0 pb-2">
          <div className="font-mono text-[11px] text-fg-3">/{doc.slug}</div>
        </header>
      ) : null}
      {/* FIELDS tab: the frontmatter form (capped) sits ABOVE the body editor.
          COMMENTS / ACTIVITY tabs: a single full-height panel, NO body editor
          (the Milkdown editor only belongs on Fields). */}
      {tab === 'fields' ? (
        <>
          <div
            data-testid="slideover-activity"
            className="folio-scroll shrink-0 max-h-[40vh] overflow-y-auto pb-3 pt-3"
          >
            {isPage ? (
              <div className="text-xs text-fg-3">No fields for pages.</div>
            ) : (
              <FrontmatterForm
                wslug={wslug}
                pslug={pslug}
                tslug={tslug}
                type={doc.type}
                // Status reads from doc.status (server truth) — it commits
                // IMMEDIATELY, it is NOT part of the buffered draft.
                status={doc.status}
                statuses={statuses ?? []}
                // Frontmatter reads from + writes to the buffered draft.
                frontmatter={draft.frontmatter}
                pinnedFields={fields ?? []}
                onStatusCommit={(next) => onStatusCommit(next)}
                onFrontmatterCommit={(p) => setFrontmatter(p)}
                pendingKeys={new Set()}
                docSlug={doc.slug}
                onOpenBacklink={(s) => void navigate({ to: '.', search: { ...search, doc: s } })}
              />
            )}
          </div>
          <div
            data-testid="slideover-editor"
            className="folio-scroll flex-1 min-h-0 overflow-y-auto border-t border-border-light pt-4 focus-within:border-fg-3"
          >
            {mode === 'rich' ? (
              <BodyEditor
                // The inner remounts on doc.id/updatedAt, so the body editor
                // remounts onto the freshly-seeded draft body with it. The
                // mode-scoped key still flips rich↔raw without remounting on a
                // toggle.
                key={`rich-${doc.slug}`}
                value={draft.body}
                onChange={(body) => setBody(body)}
                documents={docPage?.data ?? []}
                aiConfigured={aiConfigured}
                wslug={wslug}
                title={doc.title}
                showToolbar={isPage}
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
      {tab === 'comments' && workspace && project ? (
        <div className="folio-scroll min-h-0 flex-1 overflow-y-auto pt-3">
          <CommentsTab
            workspaceSlug={wslug}
            workspaceId={workspace.id}
            projectSlug={pslug}
            projectId={project.id}
            parentSlug={doc.slug}
            parentId={doc.id}
            currentUserId={me?.user?.id ?? null}
            currentAgentSlug={null}
            workspaceMembers={members ?? []}
          />
        </div>
      ) : null}
      {tab === 'activity' ? (
        <div className="folio-scroll min-h-0 flex-1 overflow-y-auto pt-3">
          <ActivityPanel wslug={wslug} pslug={pslug} slug={doc.slug} />
        </div>
      ) : null}
    </article>
  );
}
