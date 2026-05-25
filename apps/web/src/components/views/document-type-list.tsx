import { useNavigate } from '@tanstack/react-router';
import { useDocuments, type DocumentType } from '../../lib/api/documents.ts';

interface Props {
  wslug: string;
  pslug: string;
  type: DocumentType;
  title: string;
}

export function DocumentTypeList({ wslug, pslug, type, title }: Props) {
  const { data, isLoading } = useDocuments(wslug, pslug, { type });
  const navigate = useNavigate();
  const docs = data?.data ?? [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-medium tracking-tight">{title}</h1>
        <p className="mt-0.5 text-xs text-fg-2">
          {type === 'agent'
            ? 'AI agents that operate on this project. Each agent is a markdown document.'
            : 'Cron- and event-driven triggers that run agents.'}
        </p>
      </header>

      {isLoading ? (
        <div className="text-sm text-fg-2">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="rounded-md border border-border-light bg-shell p-6 text-center text-sm text-fg-2">
          {type === 'agent' ? 'No agents yet.' : 'No triggers yet.'}
        </div>
      ) : (
        <ul className="divide-y divide-border-light rounded-md border border-border-light bg-shell">
          {docs.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() =>
                  void navigate({
                    to: '.',
                    search: (prev) => ({ ...(prev as Record<string, unknown>), doc: d.slug }),
                  })
                }
                className="block w-full px-3 py-2.5 text-left hover:bg-card"
              >
                <div className="text-sm font-medium">{d.title}</div>
                <div className="mt-0.5 font-mono text-[10px] text-fg-3">/{d.slug}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
