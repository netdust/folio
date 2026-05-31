import { useState } from 'react';
import { Plus } from 'lucide-react';
import { inferFieldType } from '@folio/shared';
import type { Status } from '../../lib/api/statuses.ts';
import type { Field, FieldType } from '../../lib/api/fields.ts';
import type { DocumentType } from '../../lib/api/documents.ts';
import { useProjects } from '../../lib/api/projects.ts';
import { InlineSelect } from '../inline/inline-select.tsx';
import { FieldRenderer } from './field-renderer.tsx';
import { AssigneePicker } from '../assignee/assignee-picker.tsx';
import { ProjectsField } from '../inline/projects-field.tsx';
import { ToolsField } from '../inline/tools-field.tsx';
import { ProviderModelField } from '../inline/provider-model-field.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

// Phase 2.5: agents have a canonical field order + per-field help text so the
// slideover reads top-down (purpose → which LLM → what it can do → where it
// can act → guardrails). Anything not in this list falls back to inferred-
// alphabetical placement with no description.
interface AgentFieldMeta {
  key: string;
  description: string;
}

const AGENT_FIELDS: AgentFieldMeta[] = [
  // system_prompt removed — the agent's prompt is now its document body
  // (rendered by the body editor on the Fields tab), not a frontmatter field.
  {
    key: 'provider',
    description: 'AI provider + model. Needs a configured API key in workspace settings.',
  },
  // `model` is rendered inside the paired provider row — no standalone entry.
  {
    key: 'tools',
    description: 'MCP tools this agent can call. Read tools list/get; write tools create/update; delete removes documents.',
  },
  {
    key: 'projects',
    description: 'Projects this agent can act on. "Select all" = every workspace project, current and future.',
  },
  {
    key: 'max_delegation_depth',
    description: 'How many levels of agent-to-agent assignment this agent can trigger. 0 = cannot delegate.',
  },
  {
    key: 'max_tokens_per_run',
    description: 'Hard cap on token spend per agent run. Prevents runaway loops.',
  },
  {
    key: 'requires_approval',
    description: 'When true, the agent\'s writes wait for a human "## Approved" line in the work item body.',
  },
];

const AGENT_KEY_ORDER = AGENT_FIELDS.map((f) => f.key);
const AGENT_FIELD_DESC: Record<string, string> = Object.fromEntries(
  AGENT_FIELDS.map((f) => [f.key, f.description]),
);

function orderKeysForAgent(keys: string[]): string[] {
  const known = AGENT_KEY_ORDER.filter((k) => keys.includes(k));
  const unknown = keys.filter((k) => !AGENT_KEY_ORDER.includes(k));
  return [...known, ...unknown];
}

interface Props {
  wslug: string;
  pslug: string;
  type: DocumentType;
  status: string | null;
  statuses: Status[];
  frontmatter: Record<string, unknown>;
  pinnedFields: Field[];
  onStatusCommit: (next: string) => void;
  onFrontmatterCommit: (patch: Record<string, unknown>) => void;
  pendingKeys?: Set<string>;
}

export function FrontmatterForm({
  wslug,
  pslug,
  type,
  status,
  statuses,
  frontmatter,
  pinnedFields,
  onStatusCommit,
  onFrontmatterCommit,
  pendingKeys,
}: Props) {
  const pinnedByKey = new Map(pinnedFields.map((f) => [f.key, f]));

  // Sort keys: pinned (by `order`) first, then inferred (alphabetical).
  // Agents get a canonical field order on top of that (system_prompt first,
  // provider+model adjacent, etc.) so the slideover reads top-down.
  const inferredKeysRaw = Object.keys(frontmatter).filter((k) => !pinnedByKey.has(k));
  const inferredKeys =
    type === 'agent' ? orderKeysForAgent(inferredKeysRaw) : inferredKeysRaw.sort();
  const sortedPinned = [...pinnedFields].sort((a, b) => a.order - b.order);
  let orderedKeys = [
    ...sortedPinned.map((f) => f.key),
    ...inferredKeys.filter((k) => k in frontmatter),
  ];
  // The paired ProviderModelField renders `provider` + `model` in one row;
  // skip `model` here so it doesn't also get a standalone row.
  if (type === 'agent' && orderedKeys.includes('provider')) {
    orderedKeys = orderedKeys.filter((k) => k !== 'model');
  }

  return (
    <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2">
      {type === 'work_item' ? (
        <>
          <dt className="self-center font-mono text-[11px] text-fg-3">status</dt>
          <dd>
            <InlineSelect
              value={status}
              options={statuses.map((s) => ({ value: s.key, label: s.name, color: s.color }))}
              onCommit={onStatusCommit}
              placeholder="no status"
              renderDisplay={(opt) =>
                opt ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5"
                    style={{ backgroundColor: `${opt.color}22`, color: opt.color }}
                  >
                    {opt.label}
                  </span>
                ) : (
                  <span className="text-fg-3">no status</span>
                )
              }
            />
          </dd>
        </>
      ) : null}

      {orderedKeys.map((key) => {
        const value = frontmatter[key];
        const pinned = pinnedByKey.get(key);
        const fieldType: FieldType = pinned?.type ?? inferFieldType(value);
        const label = pinned?.label ?? key;
        const options = pinned?.options ?? undefined;
        const isAssignee = key === 'assignee';
        // Phase 2.5: the `projects` and `tools` keys on agent frontmatter render
        // as multi-select chip editors. Auto-wired by key name (same pattern as
        // `assignee`). `tools` is sourced from V1_MCP_TOOLS in @folio/shared.
        const isProjects = key === 'projects' && type === 'agent';
        const isTools = key === 'tools' && type === 'agent';
        // The `provider` key on agents renders a paired editor that owns both
        // `provider` and `model` (model has been filtered out of orderedKeys).
        const isProvider = key === 'provider' && type === 'agent';
        // Phase 2.5: short field-help text for non-obvious agent keys. Renders
        // below the input so it doesn't crowd the label column.
        const description = type === 'agent' ? AGENT_FIELD_DESC[key] : undefined;
        return (
          <div key={key} className="contents">
            <dt className="self-start pt-1 font-mono text-[11px] text-fg-3" title={key}>
              {isProvider ? 'provider · model' : label}
            </dt>
            <dd>
              {isProvider ? (
                <ProviderModelField
                  wslug={wslug}
                  provider={typeof value === 'string' ? value : 'anthropic'}
                  model={
                    typeof frontmatter['model'] === 'string'
                      ? (frontmatter['model'] as string)
                      : ''
                  }
                  onChange={(next) =>
                    onFrontmatterCommit({ provider: next.provider, model: next.model })
                  }
                />
              ) : isProjects ? (
                // Wrapped so useProjects only mounts when the agent's projects
                // field is actually being rendered — keeps non-agent tests from
                // needing a QueryClientProvider.
                <ProjectsFieldWithProjects
                  wslug={wslug}
                  value={Array.isArray(value) ? (value as string[]) : ['*']}
                  onChange={(next) => onFrontmatterCommit({ [key]: next })}
                />
              ) : isTools ? (
                <ToolsField
                  value={Array.isArray(value) ? (value as string[]) : []}
                  onChange={(next) => onFrontmatterCommit({ [key]: next })}
                />
              ) : isAssignee ? (
                <AssigneePicker
                  wslug={wslug}
                  pslug={pslug}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(next) => onFrontmatterCommit({ [key]: next })}
                />
              ) : (
                <FieldRenderer
                  fieldKey={key}
                  type={fieldType}
                  value={value}
                  options={options ?? undefined}
                  onCommit={(next) => onFrontmatterCommit({ [key]: next })}
                  isPending={pendingKeys?.has(key)}
                />
              )}
              {description ? (
                <p className="mt-1 text-[11px] leading-snug text-fg-3">{description}</p>
              ) : null}
            </dd>
          </div>
        );
      })}

      <dt className="self-center font-mono text-[11px] text-fg-3" />
      <dd>
        <AddField
          existingKeys={new Set([...Object.keys(frontmatter), ...pinnedFields.map((f) => f.key)])}
          onAdd={(key) => onFrontmatterCommit({ [key]: '' })}
        />
      </dd>
    </dl>
  );
}

function AddField({
  existingKeys,
  onAdd,
}: {
  existingKeys: Set<string>;
  onAdd: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const v = name.trim();
    if (!v) return;
    if (existingKeys.has(v)) {
      setError('Field already exists');
      return;
    }
    onAdd(v);
    setName('');
    setError(null);
    setOpen(false);
  };

  const onChange = (next: string) => {
    setName(next);
    if (error) setError(null);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setName('');
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-fg-3 hover:bg-card hover:text-fg-2"
        >
          <Icon icon={Plus} size={14} />
          Add field
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-2">
        <input
          autoFocus
          placeholder="Field name"
          value={name}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className="block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm input-focus"
        />
        {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Phase 2.5: localized subcomponent so the useProjects query only mounts when
 * the agent's `projects` field is actually rendered. Keeps the FrontmatterForm
 * tests (which mount the form for work_item/page docs) from needing to wrap a
 * QueryClientProvider.
 */
function ProjectsFieldWithProjects({
  wslug,
  value,
  onChange,
}: {
  wslug: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const projectsQ = useProjects(wslug);
  return (
    <ProjectsField
      value={value}
      projects={projectsQ.data ?? []}
      onChange={onChange}
    />
  );
}
