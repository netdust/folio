import { useNavigate } from '@tanstack/react-router';
import { useActivityFeed, type ActivityItem } from '../../lib/api/activity-feed.ts';
import { RunStatusChip } from '../runs/run-status-chip.tsx';
import { relativeTime } from '../../lib/relative-time.ts';

interface Props {
  wslug: string;
}

// ⚡ Activity screen: a live, workspace-wide tail of agent runs driven entirely
// by SSE (no workspace-wide runs-list endpoint exists). Each row links to the
// agent's slideover Runs tab — the parent work-item isn't in the run event
// payload yet, so navigating to the parent+comments is deferred (E-FOLLOWUP).
export function ActivityFeedScreen({ wslug }: Props) {
  const { items } = useActivityFeed(wslug);
  const navigate = useNavigate();

  if (items.length === 0) {
    return <div className="p-4 text-sm text-fg-3">No recent agent activity.</div>;
  }

  const openAgentRuns = (item: ActivityItem) => {
    void navigate({
      to: '/w/$wslug/agents',
      params: { wslug },
      search: { doc: item.agent, tab: 'runs' },
    });
  };

  return (
    <div className="flex flex-col overflow-y-auto">
      {items.map((item) => (
        <button
          key={item.runDocId}
          type="button"
          onClick={() => openAgentRuns(item)}
          className="flex items-center gap-2 border-b border-border-light px-4 py-2.5 text-left transition-colors duration-fast hover:bg-card"
        >
          <span className="truncate text-sm font-medium text-fg">{item.agent}</span>
          <RunStatusChip status={item.status} />
          {item.firedBy ? (
            <span className="truncate text-[11px] text-fg-3">{item.firedBy}</span>
          ) : null}
          <span className="ml-auto shrink-0 text-[11px] text-fg-3">
            {relativeTime(new Date(item.at).toISOString())}
          </span>
        </button>
      ))}
    </div>
  );
}
