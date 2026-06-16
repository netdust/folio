import { Outlet, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Loader2, PanelRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { BoardControls } from '../components/kanban/board-controls.tsx';
import { MainFrame } from '../components/shell/main-frame.tsx';
import { DocumentSlideover } from '../components/slideover/document-slideover.tsx';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { agentPanelBus } from '../lib/agent-panel-bus.ts';
import { useCreateDocument, useDocuments } from '../lib/api/documents.ts';
import { formatApiError } from '../lib/api/index.ts';
import { useProject } from '../lib/api/projects.ts';
import { useActiveView } from '../lib/api/use-active-view.ts';
import { useLiveDocuments } from '../lib/api/use-live-documents.ts';
import { useCurrentTslug } from '../lib/default-table.ts';

export const Route = createFileRoute('/w/$wslug/p/$pslug')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: ProjectLayout,
});

function ProjectLayout() {
  const { wslug, pslug } = Route.useParams();
  const navigate = useNavigate();
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
  // The kanban BoardControls gate is keyed off the ACTIVE VIEW's type (invariant 18),
  // not a URL shape. Saved-view SWITCHING lives in the rail, not the header.
  const { view: activeView } = useActiveView(wslug, pslug, tslug);

  if (isLoading) return <div className="p-8 text-fg-3">Loading project…</div>;
  if (!project) return <div className="p-8 text-danger">Project not found.</div>;

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
    <>
      <Button
        variant="primary"
        onClick={onCreate}
        disabled={create.isPending}
        className="whitespace-nowrap"
      >
        <Icon
          icon={create.isPending ? Loader2 : Plus}
          size={14}
          className={create.isPending ? 'animate-spin' : ''}
        />
        New work item
      </Button>
      {/* G4: the visible re-open affordance for the operator panel. Previously
          reachable only via Cmd-K + the workspace dropdown; this is the always-on
          toolbar toggle. Placed to the RIGHT of the primary action (Stefan, 2026-06-16). */}
      <Button
        variant="ghost"
        onClick={() => agentPanelBus.toggle()}
        aria-label="Toggle operator panel"
        title="Toggle operator panel"
        className="whitespace-nowrap"
      >
        <Icon icon={PanelRight} size={14} />
      </Button>
    </>
  );

  return (
    <>
      <MainFrame
        title={project.name}
        subMeta={`/${wslug}/p/${project.slug} · ${workCount} ${workCount === 1 ? 'work item' : 'work items'} · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`}
        actions={actions}
        tabs={
          // Saved-view switching lives in the RAIL (the single saved-views surface);
          // a header tab-per-view just duplicated it (Stefan, 2026-06-16). The header
          // only carries the ACTIVE view's controls — today that's BoardControls when
          // the active view is a kanban (invariant 18 active-view gate, not a switcher).
          activeView?.type === 'kanban' ? (
            <BoardControls wslug={wslug} pslug={pslug} tslug={tslug} />
          ) : null
        }
      >
        <Outlet />
      </MainFrame>
      <DocumentSlideover wslug={wslug} pslug={pslug} />
    </>
  );
}
