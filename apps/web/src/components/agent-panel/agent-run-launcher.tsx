import { useState } from 'react';
import { Button } from '../ui/button.tsx';
import { formatApiError } from '../../lib/api/index.ts';
import { useCreateRun, type RunMutationResult } from '../../lib/api/runs.ts';
import { useWorkspaceAgents } from '../../lib/api/workspace-documents.ts';

interface AgentRunLauncherProps {
  wslug: string;
  onLaunched: (result: RunMutationResult) => void;
}

const fieldClass =
  'w-full rounded-md border border-border-light bg-card px-2 py-1.5 text-sm text-fg ' +
  'placeholder:text-fg-3 focus:outline-none focus:ring-1 focus:ring-primary';
const labelClass = 'mb-1 block text-xs font-medium text-fg-2';

export function AgentRunLauncher({ wslug, onLaunched }: AgentRunLauncherProps) {
  const agents = useWorkspaceAgents(wslug).data ?? [];
  const create = useCreateRun(wslug);

  const [agentSlug, setAgentSlug] = useState('');
  const [parentSlug, setParentSlug] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !!agentSlug && !!parentSlug;

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      const result = await create.mutateAsync({
        agent_slug: agentSlug,
        parent_slug: parentSlug,
        input: input || undefined,
      });
      onLaunched(result);
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <label htmlFor="run-agent" className={labelClass}>
          Agent
        </label>
        <select
          id="run-agent"
          className={fieldClass}
          value={agentSlug}
          onChange={(e) => setAgentSlug(e.target.value)}
        >
          <option value="">Select an agent…</option>
          {agents.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.library ? `${a.title} (library)` : a.title}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="run-parent" className={labelClass}>
          Target document
        </label>
        <input
          id="run-parent"
          type="text"
          className={fieldClass}
          value={parentSlug}
          onChange={(e) => setParentSlug(e.target.value)}
          placeholder="document slug"
        />
      </div>

      <div>
        <label htmlFor="run-input" className={labelClass}>
          Instruction
        </label>
        <textarea
          id="run-input"
          className={fieldClass}
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Optional instruction for the agent…"
        />
      </div>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      <Button
        variant="primary"
        size="md"
        loading={create.isPending}
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="self-start"
      >
        Run agent →
      </Button>
    </div>
  );
}
