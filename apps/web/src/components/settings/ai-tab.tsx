import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  type AiProvider,
  useWorkspaceAiKeys,
  useUpsertAiKey,
  useDeleteAiKey,
} from '../../lib/api/settings.ts';
import { useTestKey } from '../../lib/api/ai-test-key.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Button } from '../ui/button.tsx';

interface Props {
  wslug: string;
  workspaceId: string;
}

const PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'openrouter', 'ollama'];

const KNOWN_MODELS: Record<AiProvider, readonly [string, ...string[]]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  openrouter: ['anthropic/claude-haiku-4-5', 'openai/gpt-4o-mini'],
  ollama: ['llama3.1', 'qwen2.5'],
};

export function AiTab({ wslug, workspaceId }: Props) {
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [model, setModel] = useState<string>(KNOWN_MODELS.anthropic[0]);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [testResult, setTestResult] = useState<null | { ok: boolean; reason?: string }>(null);

  const keysQuery = useWorkspaceAiKeys(wslug, workspaceId);
  const upsertKey = useUpsertAiKey(wslug, workspaceId);
  const deleteKey = useDeleteAiKey(wslug, workspaceId);
  const testKey = useTestKey();

  // B round 2 fix #8 — avoid painting a stale Test result onto the wrong
  // provider when the user switches the dropdown mid-flight. Compare the
  // provider captured at click-time against the latest provider via a ref;
  // closure-captured `provider` would be stale by the time the promise
  // resolves.
  const providerRef = useRef(provider);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  function onProviderChange(next: AiProvider) {
    setProvider(next);
    setModel(KNOWN_MODELS[next][0]);
    setApiKey('');
    setBaseUrl('');
    setTestResult(null);
  }

  async function onTest() {
    setTestResult(null);
    const providerAtClick = provider;
    try {
      const r = await testKey.mutateAsync({
        wslug,
        provider,
        model,
        apiKey,
        baseUrl: baseUrl || undefined,
      });
      // User switched provider during the await — discard this result so
      // an Anthropic '✓ Key validated' doesn't paint onto an OpenAI panel.
      if (providerRef.current !== providerAtClick) return;
      setTestResult(r);
    } catch (err) {
      if (providerRef.current !== providerAtClick) return;
      setTestResult({ ok: false, reason: formatApiError(err) });
    }
  }

  async function onSave() {
    try {
      await upsertKey.mutateAsync({ provider, apiKey, label: 'default', baseUrl: baseUrl || undefined });
      toast.success(`Saved ${provider} key`);
      setApiKey('');
      setBaseUrl('');
      setTestResult(null);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  }

  const inputClass =
    'mt-1 block w-full rounded-md border border-border-light bg-content px-2 py-1.5 text-sm';

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-medium">AI Provider</h2>
        <p className="mt-0.5 text-xs text-fg-2">
          Configure a provider key so agents in this workspace can talk to an LLM.
          Keys are encrypted at rest. Bring-your-own-key — Folio never holds a default.
        </p>

        <div className="mt-4 grid max-w-md gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-fg-2">Provider</span>
            <select
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as AiProvider)}
              aria-label="Provider"
              className={inputClass}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-fg-2">Model</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list={`models-${provider}`}
              aria-label="Model"
              className={inputClass}
            />
            <datalist id={`models-${provider}`}>
              {KNOWN_MODELS[provider].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-fg-2">API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label="API key"
              className={inputClass}
            />
          </label>

          {provider === 'ollama' ? (
            <label className="block">
              <span className="block text-xs font-medium text-fg-2">Base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
                aria-label="Base URL"
                className={inputClass}
              />
            </label>
          ) : null}

          <div className="mt-1 flex gap-2">
            <Button
              variant="secondary"
              onClick={onTest}
              disabled={!apiKey || testKey.isPending}
            >
              {testKey.isPending ? 'Testing…' : 'Test'}
            </Button>
            <Button onClick={onSave} disabled={!apiKey || upsertKey.isPending}>
              {upsertKey.isPending ? 'Saving…' : 'Save key'}
            </Button>
          </div>

          {testResult ? (
            <div
              role="status"
              className={testResult.ok ? 'text-xs text-success' : 'text-xs text-danger'}
            >
              {testResult.ok ? '✓ Key validated' : `✗ ${testResult.reason ?? 'Unknown error'}`}
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium">Configured keys</h2>
        <ul className="mt-2 divide-y divide-border-light overflow-hidden rounded-md border border-border-light">
          {PROVIDERS.map((p) => {
            // B round 2 fix #10 — surface non-default rows too. The Save
            // flow in this tab always writes label='default', but rows
            // created via API or pinned by an agent live alongside under
            // different labels. Previously they were invisible — the UI
            // claimed 'not configured' while a 'prod' key was in use.
            const rows = (keysQuery.data ?? []).filter((k) => k.provider === p);
            const defaultRow = rows.find((k) => k.label === 'default');
            const otherRows = rows.filter((k) => k.label !== 'default');
            return (
              <li
                key={p}
                className="flex flex-col items-stretch bg-content px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <span>
                    <span className="font-medium">{p}</span>
                    {defaultRow ? (
                      <span className="ml-2 text-xs text-fg-2">
                        ✓ default saved {new Date(defaultRow.createdAt).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="ml-2 text-xs text-fg-3">— not configured</span>
                    )}
                  </span>
                  {defaultRow ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        deleteKey
                          .mutateAsync(defaultRow.id)
                          .catch((err) => toast.error(formatApiError(err)))
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                {otherRows.length > 0 ? (
                  <div className="mt-1 text-xs text-fg-2">
                    + {otherRows.length} other label{otherRows.length === 1 ? '' : 's'} (managed via API):{' '}
                    {otherRows.map((r) => r.label).join(', ')}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
