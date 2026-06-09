import { createFileRoute, Outlet, useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { z } from 'zod';
import { Plus, Loader2, List, Columns3 } from 'lucide-react';
import { toast } from 'sonner';
import { useProject } from '../lib/api/projects.ts';
import { useDocuments, useCreateDocument } from '../lib/api/documents.ts';
import { useLiveDocuments } from '../lib/api/use-live-documents.ts';
import { DEFAULT_TABLE_SLUG, useCurrentTslug } from '../lib/default-table.ts';
import { activeTabFromPath } from '../lib/rail-nav.ts';
import { formatApiError } from '../lib/api/index.ts';
import { MainFrame, FrameTab } from '../components/shell/main-frame.tsx';
import { BoardControls } from '../components/kanban/board-controls.tsx';
import { DocumentSlideover } from '../components/slideover/document-slideover.tsx';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/ui/icon.tsx';

export const Route = createFileRoute('/w/$wslug/p/$pslug')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: ProjectLayout,
});

const TABS = [
  { id: 'work-items', label: 'Work items', path: 'work-items' as const, icon: List },
  { id: 'board', label: 'Board', path: 'board' as const, icon: Columns3 },
];

function ProjectLayout() {
  const { wslug, pslug } = Route.useParams();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  // The layout wraps every table route (/work-items, /board, /t/:tslug,
  // /t/:tslug/board), so the current table is resolved from the route, not
  // hardcoded — the tab counts + BoardControls + create must target the table
  // the user is actually viewing (invariant 16).
  const tslug = useCurrentTslug();
  const { data: project, isLoading } = useProject(wslug, pslug);
  const { data: workItems } = useDocuments(wslug, pslug, tslug, { type: 'work_item', limit: 200 });
  const { data: pages } = useDocuments(wslug, pslug, tslug, { type: 'page', limit: 200 });
  const create = useCreateDocument(wslug, pslug, tslug);
  useLiveDocuments(wslug, pslug, project?.id);

  if (isLoading) return <div className="p-8 text-fg-3">Loading project…</div>;
  if (!project) return <div className="p-8 text-danger">Project not found.</div>;

  const path = routerState.location.pathname;
  // Table-route-aware: a /t/<tslug>/board path lights Board, a bare /t/<tslug>
  // (or /work-items) lights the grid. A plain `endsWith('/'+path)` would miss
  // both /t/<tslug> shapes and wrongly fall through to the work-items default.
  const isDefaultTable = tslug === DEFAULT_TABLE_SLUG;
  const activeTab = activeTabFromPath(path) ?? 'work-items';
  // The two table tabs route to the CURRENT table's grid + board. On the default
  // table that's the legacy /work-items + /board routes (no :tslug); on any other
  // table it's /t/<tslug> + /t/<tslug>/board.
  const tableTabTo = (tab: 'work-items' | 'board') =>
    isDefaultTable
      ? (`/w/$wslug/p/$pslug/${tab}` as const)
      : tab === 'board'
        ? ('/w/$wslug/p/$pslug/t/$tslug/board' as const)
        : ('/w/$wslug/p/$pslug/t/$tslug' as const);
  const tableTabParams = isDefaultTable ? { wslug, pslug } : { wslug, pslug, tslug };

  const workCount = workItems?.data.length ?? 0;
  const pageCount = pages?.data.length ?? 0;

  const onCreate = async () => {
    try {
      const created = await create.mutateAsync({ type: 'work_item', title: 'Untitled' });
      void navigate({ to: '.', search: { ...search, doc: created.slug }, replace: false });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const actions = (
    <Button variant="primary" onClick={onCreate} disabled={create.isPending} className="whitespace-nowrap">
      <Icon icon={create.isPending ? Loader2 : Plus} size={14} className={create.isPending ? 'animate-spin' : ''} />
      New work item
    </Button>
  );

  return (
    <>
      <MainFrame
        title={project.name}
        subMeta={`/${wslug}/p/${project.slug} · ${workCount} ${workCount === 1 ? 'work item' : 'work items'} · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`}
        actions={actions}
        tabs={
          <>
            {TABS.map((t) => (
              <FrameTab
                key={t.id}
                active={activeTab === t.id}
                icon={t.icon}
                onClick={() =>
                  navigate({
                    to: tableTabTo(t.path),
                    params: tableTabParams,
                    search: (s) => s,
                  })
                }
              >
                {t.label}
              </FrameTab>
            ))}
            {activeTab === 'board' ? (
              <>
                <div className="mx-1 h-5 w-px self-center bg-border-light" aria-hidden />
                <BoardControls wslug={wslug} pslug={pslug} tslug={tslug} />
              </>
            ) : null}
          </>
        }
      >
        <Outlet />
      </MainFrame>
      <DocumentSlideover wslug={wslug} pslug={pslug} />
    </>
  );
}
