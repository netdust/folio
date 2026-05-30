import type { AgentRunDoc } from '../../lib/api/runs.ts';
import { RunStatusChip } from './run-status-chip.tsx';

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

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
