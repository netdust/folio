import { useRef, useState } from 'react';
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

  // B round 3 fix #9 — replace the round-2 providerRef + useEffect pattern
  // with monotonically-incrementing sequence ids per inflight operation.
  // The ref-via-effect approach left a microtask race window: between a
  // mutation's resolve callback running and the next render's effect flush,
  // providerRef.current still pointed at the previous value. The seq pattern
  // is synchronous — incrementing is committed BEFORE any further await.
  //
  // Separate seqs per operation (test vs save) so they don't invalidate each
  // other; both seqs ALSO bump on provider-change so any inflight work for
  // the abandoned provider gets discarded.
  const testSeqRef = useRef(0);
  const saveSeqRef = useRef(0);

  function onProviderChange(next: AiProvider) {
    setProvider(next);
    setModel(KNOWN_MODELS[next][0]);
    setApiKey('');
    setBaseUrl('');
    setTestResult(null);
    // Invalidate any in-flight Test / Save — when their promises resolve,
    // the seq comparison rejects them.
    testSeqRef.current += 1;
    saveSeqRef.current += 1;
  }

  // B round 4 fix #5 — honest toast wording. The client.post does NOT accept
  // an AbortSignal, and useUpsertAiKey's mutationFn doesn't forward one
  // either, so the server-side write CANNOT be aborted from the UI once
  // dispatched. The round-3 seq-id guard suppressed the toast but the row
  // was already committed for the OLD provider. Replacing the silent
  // suppression with a truthful info-toast: "Save completed for previous
  // provider" — the user sees what actually happened, no lie.
  //
  // Long-term: thread an AbortSignal through client.post + useUpsertAiKey
  // so the fetch is actually canceled. Deferred per "Out of scope" in the
  // plan's threat model (mitigation 17).

  // Round 7 #13 — mirror onSave's honest-info-toast pattern onto onTest. The
  // useTestKey mutation hits the upstream provider with the click-time
  // provider's apiKey + baseUrl; switching the dropdown mid-flight cannot
  // abort the in-flight HTTP fetch. Pre-round-7 the stale-seq guard silently
  // dropped the result, leaving the user unaware that:
  //   - the upstream provider was hit (telemetry, rate-limit consumption);
  //   - the apiKey value was sent (potential audit-log entry on a third
  //     provider's side);
  //   - whether the key was valid (the actual answer is gone).
  // Surface a truthful info-toast so the user knows the test happened for
  // the click-time provider. Whether the user sees the result rendered in
  // the chip is not the same as whether the side effect happened.
  async function onTest() {
    setTestResult(null);
    const providerAtClick = provider;
    const seq = ++testSeqRef.current;
    try {
      const r = await testKey.mutateAsync({
        wslug,
        provider,
        model,
        apiKey,
        baseUrl: baseUrl || undefined,
      });
      if (seq !== testSeqRef.current) {
        toast.info(`Test completed for previous provider (${providerAtClick})`);
        return;
      }
      setTestResult(r);
    } catch (err) {
      if (seq !== testSeqRef.current) {
        toast.info(`Test completed for previous provider (${providerAtClick})`);
        return;
      }
      setTestResult({ ok: false, reason: formatApiError(err) });
    }
  }

  async function onSave() {
    // B round 3 fix #7 — mirror the seq-id guard onto Save. Pre-fix the toast
    // closed over `provider` at definition time, so a user who clicked Save
    // on Anthropic then switched to OpenAI before the mutation resolved
    // would see "Saved openai key" — but the row that landed in the DB is
    // an anthropic one. Capture the click-time provider AND check the seq
    // before painting.
    //
    // B round 4 fix #5 — on stale-seq, surface a TRUTHFUL info toast naming
    // the click-time provider, instead of silently dropping the success.
    // The mutation already committed server-side (client.post can't be
    // aborted), so the row was written for the OLD provider. Hiding that
    // from the user is a lie. Whether the user sees the result or not is
    // not the same as whether the side effect happened.
    const providerAtClick = provider;
    const seq = ++saveSeqRef.current;
    try {
      await upsertKey.mutateAsync({
        provider: providerAtClick,
        apiKey,
        label: 'default',
        baseUrl: baseUrl || undefined,
      });
      if (seq !== saveSeqRef.current) {
        // User changed provider mid-flight. The server-side write completed
        // for `providerAtClick` — tell them so they aren't surprised by it.
        toast.info(`Save completed for previous provider (${providerAtClick})`);
        return;
      }
      toast.success(`Saved ${providerAtClick} key`);
      setApiKey('');
      setBaseUrl('');
      setTestResult(null);
    } catch (err) {
      if (seq !== saveSeqRef.current) {
        // Failed save under provider-change — still surface it so the user
        // knows the OLD provider's row is NOT written. Silent drop would
        // leave them unsure.
        toast.info(`Save failed for previous provider (${providerAtClick})`);
        return;
      }
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
                /*
                 * B round 4 fix #8 — placeholder honesty. Pre-fix the
                 * placeholder showed http://localhost:11434, the exact value
                 * validatePublicUrl rejects post-round-3 (SSRF guard). A
                 * self-hosted admin typing the placeholder hit 422 and
                 * concluded the feature was broken. Use a publicly-resolvable
                 * example + a help line spelling out the loopback restriction.
                 */
                placeholder="https://ollama.example.com"
                aria-label="Base URL"
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-fg-3">
                Must be reachable from the Folio server, not your browser.
                Loopback addresses (localhost, 127.0.0.1, private ranges) are rejected.
              </span>
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
            // B round 2 fix #10 + round 3 fix #8 — surface non-default rows.
            // Round-2 listed them but the header still said "not configured"
            // when only non-default rows existed: the UI was lying. Now the
            // header reflects what's actually in the DB:
            //   - rows.length === 0           → "not configured"
            //   - default exists              → "✓ default saved <date>"
            //   - only non-default rows       → "configured via API (no default-label key)"
            const rows = (keysQuery.data ?? []).filter((k) => k.provider === p);
            const defaultRow = rows.find((k) => k.label === 'default');
            const otherRows = rows.filter((k) => k.label !== 'default');
            const noRows = rows.length === 0;
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
                    ) : noRows ? (
                      <span className="ml-2 text-xs text-fg-3">— not configured</span>
                    ) : (
                      <span className="ml-2 text-xs text-fg-2">
                        configured via API (no default-label key)
                      </span>
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
                    {otherRows.length} other label
                    {otherRows.length === 1 ? '' : 's'} (managed via API):
                    {/*
                      B round 3 fix #14 — surface baseUrl alongside the label for
                      ollama rows. An admin who pinned an internal-only host via
                      API needs to see it; the row was previously a bare label.
                    */}
                    <ul className="mt-0.5 space-y-0.5">
                      {otherRows.map((r) => (
                        <li key={r.id} className="font-mono text-fg-2">
                          {r.label}
                          {r.baseUrl ? (
                            <span className="ml-2 text-fg-3">→ {r.baseUrl}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
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
