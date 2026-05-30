import type { AgentRunDoc } from '../../lib/api/runs.ts';
import { relativeTime } from '../../lib/relative-time.ts';
import { RunStatusChip } from './run-status-chip.tsx';

interface RunRowProps {
  run: AgentRunDoc;
  docTitle?: string;
  onClick?: () => void;
}

export function RunRow({ run, docTitle, onClick }: RunRowProps) {
  const fm = run.frontmatter;
  const agent = (fm.agent_slug as string | undefined) ?? '—';
  const firedBy = (fm.fired_by as string | undefined) ?? '';
  const status = run.status ?? (fm.status as string | undefined) ?? 'unknown';
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      className={`border-b border-border-light px-3 py-2.5 text-sm ${onClick ? 'cursor-pointer hover:bg-card' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <strong className="text-fg-2">{agent}</strong>
        {docTitle ? <span className="text-fg-3">· {docTitle}</span> : null}
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-fg-3">
        <RunStatusChip status={status} />
        {firedBy ? <span>· {firedBy}</span> : null}
        <span>· {relativeTime(run.createdAt)}</span>
        {fm.error_reason ? <span className="text-danger">· {String(fm.error_reason)}</span> : null}
      </div>
    </div>
  );
}
