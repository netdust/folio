import { useEffect, useState, useMemo } from 'react';
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

type DocTabValue = 'fields' | 'comments' | 'activity';

interface Props {
  wslug: string;
  pslug: string;
}

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

  // Tab state lives here (not in SlideoverBody) so the icon toggles can render
  // inline in the header — NocoDB-style single row — while the body reads the
  // active tab. Resets to Fields whenever a different doc opens.
  const [tab, setTab] = useState<DocTabValue>('fields');
  useEffect(() => {
    setTab('fields');
  }, [doc?.id]);
  // Comment count drives the Comments-tab badge (HeaderTabs renders it when >0).
  // Gated on doc.slug so it idles until the doc resolves. Pass the SAME default
  // visibility (['normal']) that CommentsTab uses with the toggle off, so this
  // query shares CommentsTab's react-query key (a cache hit, not a second
  // fetch) AND the badge count matches the rows the tab renders. (A user who
  // flips CommentsTab's show-internal toggle will see internal comments the
  // badge doesn't count — an acceptable minor drift; the badge tracks the
  // default view.)
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

  const close = () => {
    const { doc: _doc, ...next } = search;
    void navigate({ to: '.', search: next });
  };

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
          {slug ? (
            <SlideoverBody
              wslug={wslug}
              pslug={pslug}
              slug={slug}
              mode={mode}
              tab={tab}
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
  wslug,
  pslug,
  slug,
  mode,
  tab,
}: {
  wslug: string;
  pslug: string;
  slug: string;
  mode: EditorMode;
  tab: DocTabValue;
}) {
  const { data: doc, isLoading, error } = useDocument(wslug, pslug, slug);
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug, 'work-items');
  const listParams = useUrlDerivedListParams(doc?.type ?? 'work_item');
  const update = useUpdateDocument(wslug, pslug, listParams);
  // Documents list — same listParams as useUpdateDocument so React Query
  // dedupes the key. Gated on `doc` so we don't fire the request with the
  // default 'work_item' type before the real doc.type is known (would cause
  // a wrong-type slash-menu flash for page docs + a redundant roundtrip).
  const { data: docPage } = useDocuments(wslug, pslug, listParams, { enabled: !!doc });
  // AI key presence — drives the slash menu's aiConfigured flag
  const { data: workspace } = useWorkspace(wslug);
  const { data: project } = useProject(wslug, pslug);
  const { data: aiKeys } = useWorkspaceAiKeys(wslug, workspace?.id ?? '');
  const aiConfigured = (aiKeys ?? []).length > 0;
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

  // Comments + members + current user — for the Comments tab (work_item/page
  // only). The hook is gated on doc.slug so it idles until the doc resolves.
  const { data: members } = useMembers(wslug);
  const { data: me } = useMe();
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
                status={doc.status}
                statuses={statuses ?? []}
                frontmatter={doc.frontmatter}
                pinnedFields={fields ?? []}
                onStatusCommit={(next) => void onPatch({ status: next }, ['status'])}
                onFrontmatterCommit={(p) => void onPatch({ frontmatter: p }, Object.keys(p))}
                pendingKeys={pendingKeys}
              />
            )}
          </div>
          <div
            data-testid="slideover-editor"
            className="folio-scroll flex-1 min-h-0 overflow-y-auto border-t border-border-light pt-4 focus-within:border-fg-3"
          >
            {mode === 'rich' ? (
              <BodyEditor
                key={`rich-${doc.slug}`}
                value={doc.body}
                onChange={(body) => onPatch({ body }, ['body'])}
                documents={docPage?.data ?? []}
                aiConfigured={aiConfigured}
                showToolbar={isPage}
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
