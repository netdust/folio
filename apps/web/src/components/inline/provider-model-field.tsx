import { useState } from 'react';
import type { AiProvider } from '../../lib/api/settings.ts';
import { useWorkspace } from '../../lib/api/workspaces.ts';
import { useWorkspaceAiKeys } from '../../lib/api/settings.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

interface Props {
  wslug: string;
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
}

interface ProviderInfo {
  id: AiProvider | 'claude-code';
  label: string;
  models: string[];
  freeText: boolean;
}

// Hardcoded model catalogue per the shake-out call. OpenRouter / Ollama are
// open-ended (free-text model field) — too many SKUs to enumerate, and the
// concrete names change weekly.
const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
    freeText: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini'],
    freeText: false,
  },
  { id: 'openrouter', label: 'OpenRouter', models: [], freeText: true },
  { id: 'ollama', label: 'Ollama', models: [], freeText: true },
];

const CLAUDE_CODE_PROVIDER: ProviderInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  models: [],
  freeText: true,
};

/**
 * Paired editor for `provider` + `model` on agent frontmatter. Provider is a
 * select scoped to PROVIDERS; model is either a select (if the provider has
 * a known model list) or a free-text input (for OpenRouter / Ollama).
 *
 * The provider list annotates each entry with whether the workspace has a
 * configured AI key for it — agents pointing at a provider with no key will
 * silently fail at runtime, so surface that here.
 *
 * When `claude_code_enabled` is set on the workspace, a `claude-code` provider
 * is appended. It is keyless by design — a "no key needed" chip replaces the
 * normal "no key" warning.
 */
export function ProviderModelField({ wslug, provider, model, onChange }: Props) {
  const { data: workspace } = useWorkspace(wslug);
  const { data: aiKeys } = useWorkspaceAiKeys(wslug, workspace?.id ?? '');
  const configuredProviders = new Set((aiKeys ?? []).map((k) => k.provider));

  const claudeCodeEnabled =
    (workspace as { claude_code_enabled?: boolean } | undefined)?.claude_code_enabled ?? false;

  const providers: ProviderInfo[] = claudeCodeEnabled
    ? [...PROVIDERS, CLAUDE_CODE_PROVIDER]
    : PROVIDERS;

  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  const currentProviderInfo = providers.find((p) => p.id === provider) ?? providers[0]!;
  const providerLabel = currentProviderInfo.label;
  const isCurrentClaudeCode = currentProviderInfo.id === 'claude-code';
  const currentHasKey = isCurrentClaudeCode || configuredProviders.has(currentProviderInfo.id as AiProvider);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Provider select */}
      <Popover open={providerOpen} onOpenChange={setProviderOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex h-7 items-center rounded-md border border-border-light bg-content px-2 text-sm text-fg hover:bg-card"
          >
            {providerLabel}
            {isCurrentClaudeCode ? (
              <span className="ml-1.5 rounded-full bg-fg-3/15 px-1.5 py-0.5 text-[10px] font-medium text-fg-3">
                no key needed
              </span>
            ) : !currentHasKey ? (
              <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                no key
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[220px] p-1" align="start">
          {providers.map((p) => {
            const isClaudeCode = p.id === 'claude-code';
            const hasKey = isClaudeCode || configuredProviders.has(p.id as AiProvider);
            const isCurrent = p.id === provider;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setProviderOpen(false);
                  // Reset model when switching provider unless the current model
                  // is in the new provider's list — preserves valid pairings.
                  const nextModel = p.models.includes(model)
                    ? model
                    : p.models[0] ?? '';
                  onChange({ provider: p.id, model: nextModel });
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-card ${
                  isCurrent ? 'bg-card' : ''
                }`}
              >
                <span>{p.label}</span>
                {isClaudeCode ? (
                  <span className="rounded-full bg-fg-3/15 px-1.5 py-0.5 text-[10px] font-medium text-fg-3">
                    no key needed
                  </span>
                ) : !hasKey ? (
                  <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                    no key
                  </span>
                ) : null}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>

      {/* Model select / input */}
      {currentProviderInfo.freeText ? (
        <input
          type="text"
          value={model}
          onChange={(e) => onChange({ provider, model: e.target.value })}
          placeholder="model name"
          className="h-7 rounded-md border border-border-light bg-content px-2 text-sm input-focus"
        />
      ) : (
        <Popover open={modelOpen} onOpenChange={setModelOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md border border-border-light bg-content px-2 text-sm text-fg hover:bg-card"
            >
              {model || <span className="text-fg-3">choose model</span>}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[260px] p-1" align="start">
            {currentProviderInfo.models.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setModelOpen(false);
                  onChange({ provider, model: m });
                }}
                className={`block w-full rounded-md px-2 py-1.5 text-left text-sm font-mono hover:bg-card ${
                  m === model ? 'bg-card' : ''
                }`}
              >
                {m}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
