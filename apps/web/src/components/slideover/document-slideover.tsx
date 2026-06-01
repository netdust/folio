import { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Clipboard, FileText, History, MessageCircle, MoreHorizontal, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { HeaderTabs, type HeaderTabItem } from './header-tabs.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';
import {
  type Document,
  type DocumentListParams,
  clausesToListParams,
  parseFilters,
  useDocument,
  useDocuments,
  useUpdateDocument,
  useDeleteDocument,
} from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useWorkspace } from '../../lib/api/workspaces.ts';
import { useProject } from '../../lib/api/projects.ts';
import { useWorkspaceAiKeys } from '../../lib/api/settings.ts';
import { useComments } from '../../lib/api/comments.ts';
import { useMembers } from '../../lib/api/members.ts';
import { useMe } from '../../lib/api/auth.ts';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { FrontmatterForm } from './frontmatter-form.tsx';
import { BodyEditor } from './body-editor.tsx';
import { ModeToggle, type EditorMode } from './mode-toggle.tsx';
import { RawMdEditor } from './raw-md-editor.tsx';
import { LogActivityButton } from './log-activity-button.tsx';
import { ActivityPanel } from './activity-panel.tsx';
import { CommentsTab } from '../comments/comments-tab.tsx';
import { useDocumentDraft } from '../../lib/use-document-draft.ts';
import { useLiveDocument } from '../../lib/use-live-document.ts';
import { ExternalUpdateBanner } from './external-update-banner.tsx';
import { SaveButton } from './save-button.tsx';
import { useQueryClient } from '@tanstack/react-query';
import { documentsKeys } from '../../lib/api/documents.ts';

type DocTabValue = 'fields' | 'comments' | 'activity';

interface InnerActions {
  save: () => Promise<void>;
  discard: () => void;
}

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
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { doc?: string };
  const open = !!search.doc;
  const slug = search.doc ?? null;
  const { data: doc, isLoading, error } = useDocument(wslug, pslug, slug);
  const [mode, setMode] = useState<EditorMode>('rich');
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteDocument(wslug, pslug);

  // Dirtiness + saving are OWNED by the keyed inner (it owns the draft) and
  // MIRRORED up here so the header Save button + close/switch guard can read
  // them. Imperative save/discard come back via the actions ref.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const actionsRef = useRef<InnerActions | null>(null);

  // Tab state lives here (not in the inner) so the icon toggles render inline in
  // the header — NocoDB-style single row — AND so a tab switch doesn't remount
  // the draft-owning inner. Resets to Fields whenever a different doc opens.
  const [tab, setTab] = useState<DocTabValue>('fields');
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

  // ----- close + doc-switch guard ------------------------------------------
  // Because the inner remounts on a doc switch (clearing its own isDirty before
  // any effect could observe it), we LATCH the slug whose buffer was dirty so
  // the switch still routes through the prompt. The latch is set whenever the
  // inner reports dirty, released when it reports clean for the loaded doc.
  const dirtySlugRef = useRef<string | null>(null);
  if (doc?.slug && dirty) dirtySlugRef.current = doc.slug;
  else if (doc?.slug && doc.slug === dirtySlugRef.current && !dirty) dirtySlugRef.current = null;

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
    const { doc: _doc, ...next } = search;
    void navigate({ to: '.', search: next });
  };
  const close = () => guard(doClose);

  // Guard doc-SWITCH (not just close): if the URL doc flips to a DIFFERENT slug
  // while the buffer is dirty, intercept — revert the URL to the latched (still
  // dirty) doc and prompt. The guard's queued action re-applies the intended
  // switch once the buffer is resolved (Save remounts the inner clean, Discard
  // resets it).
  //
  // Detection runs DURING render (not in a [search.doc] effect): switching doc
  // unloads the old doc and remounts the inner clean, so by the time an effect
  // fires both `dirty` AND the loaded slug have already moved on. Comparing the
  // committed doc to the previous one during render catches the flip while
  // dirtySlugRef still names the dirty doc.
  const prevDocRef = useRef<string | undefined>(search.doc);
  const pendingSwitchRef = useRef<string | null>(null);
  if (prevDocRef.current !== search.doc) {
    const incoming = search.doc;
    const dirtySlug = dirtySlugRef.current;
    if (incoming && dirtySlug && incoming !== dirtySlug) {
      pendingSwitchRef.current = incoming;
    }
    prevDocRef.current = incoming;
  }
  useEffect(() => {
    const incoming = pendingSwitchRef.current;
    const dirtySlug = dirtySlugRef.current;
    pendingSwitchRef.current = null;
    if (!incoming || !dirtySlug || incoming === dirtySlug) return;
    // Revert URL to the dirty doc and queue the intended switch behind the guard.
    void navigate({ to: '.', search: { ...search, doc: dirtySlug } });
    guard(() => navigate({ to: '.', search: { ...search, doc: incoming } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.doc]);

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

  // Shared key — the crux of the refetch-stomp fix: a doc switch OR a post-save
  // updatedAt bump remounts the inner → a fresh useDocumentDraft seed from the
  // loaded doc. The inner is null until a REAL doc loads, so it never sees the
  // loading placeholder.
  const innerKey = doc ? `${doc.id}:${doc.updatedAt}` : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <SheetContent width={800} className="h-screen">
        <SheetHeader>
          <SheetTitle>
            {isLoading ? (
              <Skeleton width={200} height={20} />
            ) : error ? (
              'Failed to load'
            ) : doc ? (
              // key={doc.id} forces a remount when the user opens a different
              // doc without closing the slideover (e.g., create A → Cmd-K → create
              // B). InlineEdit reads `defaultEditing` once at mount, so without
              // the key the second freshly-created "Untitled" wouldn't auto-edit.
              <SlideoverTitleEditor key={doc.id} doc={doc} wslug={wslug} pslug={pslug} />
            ) : (
              '—'
            )}
          </SheetTitle>
          <div data-testid="slideover-toolbar" className="flex items-center gap-1.5">
            {doc ? (
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
                <SaveButton dirty={dirty} saving={saving} onSave={() => void actionsRef.current?.save()} />
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
            ) : null}
            <IconButton label="Close document" onClick={close}>
              <Icon icon={X} size={16} />
            </IconButton>
          </div>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-hidden px-6 py-4">
          {slug && doc && innerKey ? (
            <DocumentSlideoverInner
              key={innerKey}
              doc={doc}
              wslug={wslug}
              pslug={pslug}
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
        onOpenChange={(o) => {
          if (!del.isPending) setConfirmDelete(o);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete this document?</DialogTitle>
          <DialogDescription>
            {doc ? <>Delete &ldquo;{doc.title}&rdquo;? This cannot be undone.</> : null}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmDelete(false)}
              disabled={del.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void onDelete()}
              disabled={del.isPending}
            >
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
            <Button variant="secondary" onClick={() => { actionsRef.current?.discard(); proceed(); }}>
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
  mode,
  tab,
  onDirtyChange,
  onSavingChange,
  actionsRef,
}: {
  doc: Document;
  wslug: string;
  pslug: string;
  mode: EditorMode;
  tab: DocTabValue;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  actionsRef: React.MutableRefObject<InnerActions | null>;
}) {
  const listParams = useUrlDerivedListParams(doc.type);
  const update = useUpdateDocument(wslug, pslug, listParams);
  const qc = useQueryClient();
  const { draft, setBody, setFrontmatter, isDirty, reset, diff } = useDocumentDraft(doc);

  // Live external-update awareness (notify-don't-stomp): a clean draft pulls
  // server truth on a remote document.updated; a DIRTY draft shows a banner and
  // is NEVER refetched (would overwrite unsaved typing). Deletions always banner.
  const { externalUpdate, dismiss } = useLiveDocument({
    wslug,
    docId: doc.id,
    isDirty,
    onRefetch: () => qc.invalidateQueries({ queryKey: documentsKeys.detail(wslug, pslug, doc.slug) }),
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

function SlideoverTitleEditor({ doc, wslug, pslug }: { doc: Document; wslug: string; pslug: string }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const listParams = useUrlDerivedListParams(doc.type);
  const update = useUpdateDocument(wslug, pslug, listParams);
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
  mode: EditorMode;
  tab: DocTabValue;
  draft: { body: string; frontmatter: Record<string, unknown> };
  setBody: (body: string) => void;
  setFrontmatter: (patch: Record<string, unknown>) => void;
  onStatusCommit: (next: string) => void;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug, 'work-items');
  const listParams = useUrlDerivedListParams(doc.type);
  // Documents list — same listParams as the inner's useUpdateDocument so React
  // Query dedupes the key. Feeds the body editor's slash-menu document links.
  const { data: docPage } = useDocuments(wslug, pslug, listParams, { enabled: true });
  // AI key presence — drives the slash menu's aiConfigured flag
  const { data: workspace } = useWorkspace(wslug);
  const { data: project } = useProject(wslug, pslug);
  const { data: aiKeys } = useWorkspaceAiKeys(wslug, workspace?.id ?? '');
  const aiConfigured = (aiKeys ?? []).length > 0;

  // Comments + members + current user — for the Comments tab (work_item/page
  // only). The hook is gated on doc.slug so it idles until the doc resolves.
  const { data: members } = useMembers(wslug);
  const { data: me } = useMe();

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
                onOpenBacklink={(s) =>
                  void navigate({ to: '.', search: { ...search, doc: s } })
                }
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
