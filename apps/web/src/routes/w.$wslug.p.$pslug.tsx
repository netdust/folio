import { createFileRoute, Outlet, useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { z } from 'zod';
import { Plus, Loader2, List, Columns3 } from 'lucide-react';
import { toast } from 'sonner';
import { useProject } from '../lib/api/projects.ts';
import { useDocuments, useCreateDocument } from '../lib/api/documents.ts';
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
  const { data: project, isLoading } = useProject(wslug, pslug);
  const { data: workItems } = useDocuments(wslug, pslug, { type: 'work_item', limit: 200 });
  const { data: pages } = useDocuments(wslug, pslug, { type: 'page', limit: 200 });
  const create = useCreateDocument(wslug, pslug);

  if (isLoading) return <div className="p-8 text-fg-3">Loading project…</div>;
  if (!project) return <div className="p-8 text-danger">Project not found.</div>;

  const path = routerState.location.pathname;
  const activeTab = TABS.find((t) => path.endsWith(`/${t.path}`))?.id ?? 'work-items';

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
                    to: `/w/$wslug/p/$pslug/${t.path}`,
                    params: { wslug, pslug },
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
                <BoardControls wslug={wslug} pslug={pslug} tslug="work-items" />
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
