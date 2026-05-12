import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useProjects } from '../lib/api/projects.ts';
import { useWorkspace } from '../lib/api/workspaces.ts';
import { MainFrame } from './shell/main-frame.tsx';
import { Button } from './ui/button.tsx';

interface Props {
  wslug: string;
  onCreate: () => void;
}

export function ProjectPicker({ wslug, onCreate }: Props) {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useProjects(wslug);
  const { data: workspace } = useWorkspace(wslug);

  useEffect(() => {
    if (projects && projects.length === 1) {
      void navigate({
        to: '/w/$wslug/p/$pslug/work-items',
        params: { wslug, pslug: projects[0]!.slug },
        replace: true,
      });
    }
  }, [projects, navigate, wslug]);

  const title = workspace?.name ?? wslug;
  const subMeta = `/${wslug}`;

  if (isLoading) {
    return (
      <MainFrame title={title} subMeta={subMeta}>
        <div className="p-4 text-fg-3">Loading projects…</div>
      </MainFrame>
    );
  }
  if (error) {
    return (
      <MainFrame title={title} subMeta={subMeta}>
        <div className="p-4 text-danger">Failed to load projects.</div>
      </MainFrame>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <MainFrame title={title} subMeta={subMeta}>
        <div className="flex h-full items-center justify-center">
          <div className="max-w-md text-center">
            <h2 className="text-xl font-semibold text-fg">No projects yet</h2>
            <p className="mt-2 text-fg-3">Create your first project to get started.</p>
            <Button className="mt-6" onClick={onCreate}>Create project</Button>
          </div>
        </div>
      </MainFrame>
    );
  }

  if (projects.length === 1) return null;

  return (
    <MainFrame
      title={title}
      subMeta={subMeta}
      actions={<Button variant="secondary" onClick={onCreate}>New project</Button>}
    >
      <ul className="mx-auto mt-2 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              to="/w/$wslug/p/$pslug/work-items"
              params={{ wslug, pslug: p.slug }}
              className="block rounded-lg border border-border-light bg-content p-4 hover:bg-card"
            >
              <div className="flex items-center gap-2">
                {p.icon ? <span className="text-base">{p.icon}</span> : null}
                <span className="text-base font-medium text-fg">{p.name}</span>
              </div>
              <div className="mt-1 font-mono text-xs text-fg-3">/{p.slug}</div>
            </Link>
          </li>
        ))}
      </ul>
    </MainFrame>
  );
}
