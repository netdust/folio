import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useProject } from '../lib/api/projects.ts';
import { MainFrame, FrameTab } from '../components/shell/main-frame.tsx';

export const Route = createFileRoute('/w/$wslug/p/$pslug')({
  component: ProjectLayout,
});

const TABS = [
  { id: 'work-items', label: 'Work items', path: 'work-items' as const },
  { id: 'board', label: 'Board', path: 'board' as const },
  { id: 'wiki', label: 'Wiki', path: 'wiki' as const },
];

function ProjectLayout() {
  const { wslug, pslug } = Route.useParams();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const { data: project, isLoading } = useProject(wslug, pslug);

  if (isLoading) return <div className="p-8 text-fg-3">Loading project…</div>;
  if (!project) return <div className="p-8 text-danger">Project not found.</div>;

  const path = routerState.location.pathname;
  const activeTab = TABS.find((t) => path.endsWith(`/${t.path}`))?.id ?? 'work-items';

  return (
    <MainFrame
      title={project.name}
      subMeta={`/${wslug}/p/${project.slug}`}
      tabs={
        <>
          {TABS.map((t) => (
            <FrameTab
              key={t.id}
              active={activeTab === t.id}
              onClick={() =>
                navigate({
                  to: `/w/$wslug/p/$pslug/${t.path}`,
                  params: { wslug, pslug },
                })
              }
            >
              {t.label}
            </FrameTab>
          ))}
        </>
      }
    >
      <Outlet />
    </MainFrame>
  );
}
