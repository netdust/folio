import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { KNOWN_EVENT_KINDS } from '@folio/shared';
import { useWorkspaceAgents } from '../../lib/api/workspace-documents.ts';
import { CronInput } from './cron-input.tsx';
import { cn } from '../ui/cn.ts';

/**
 * Phase 2.6 sub-phase D6.
 *
 * Structured editor for trigger frontmatter. Replaces the generic
 * `<FrontmatterForm />` for trigger documents because the field set is
 * tightly bound (cron OR event, agent OR `$event.<key>`, JSON payload,
 * builtin lock, etc.) and a generic key/value form makes those constraints
 * invisible.
 *
 * The form is purely controlled: every keystroke produces a new `value` via
 * `onChange`. The parent (D7 slideover) decides when to PATCH.
 */
export interface TriggerFormProps {
  value: {
    title: string;
    body: string;
    frontmatter: Record<string, unknown>;
  };
  onChange: (next: {
    title: string;
    body: string;
    frontmatter: Record<string, unknown>;
  }) => void;
  workspaceSlug: string;
  /** Optional project filter for the agent dropdown. If omitted, lists all workspace agents. */
  projectId?: string;
}

type Mode = 'schedule' | 'event';

const EVENT_OPTION_VALUE = '__event__';

function modeOf(frontmatter: Record<string, unknown>): Mode {
  return frontmatter.schedule != null ? 'schedule' : 'event';
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/** event_filter is rendered as a list of {key, value} string rows in v1. */
interface FilterRow {
  key: string;
  value: string;
}

function filterToRows(filter: Record<string, unknown> | null): FilterRow[] {
  if (!filter) return [];
  return Object.entries(filter).map(([k, v]) => ({
    key: k,
    // Render non-string scalars as their JSON text so the user can see/edit them.
    value: typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v),
  }));
}

function rowsToFilter(rows: FilterRow[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return Object.keys(out).length ? out : null;
}

export function TriggerForm({ value, onChange, workspaceSlug, projectId }: TriggerFormProps) {
  const fm = value.frontmatter;
  const builtin = asBool(fm.builtin, false);
  const enabled = asBool(fm.enabled, true);
  const mode: Mode = modeOf(fm);

  // Agent select — fetch workspace agents (optionally filtered to a project).
  const agentsQ = useWorkspaceAgents(workspaceSlug, { project: projectId });
  const agents = agentsQ.data ?? [];

  const agentRaw = fm.agent;
  const agentIsCustomFrontmatter = typeof agentRaw === 'string' && agentRaw.startsWith('$event.');

  // Track whether the user picked "— event field —" locally so the custom
  // input shows up even when the parent's onChange is a pure spy (i.e. the
  // controlled value isn't actually round-tripped back). Sync from
  // frontmatter when it changes externally.
  const [agentSelectLocal, setAgentSelectLocal] = useState<string>(
    agentRaw == null ? '' : agentIsCustomFrontmatter ? EVENT_OPTION_VALUE : asString(agentRaw),
  );
  useEffect(() => {
    setAgentSelectLocal(
      agentRaw == null ? '' : agentIsCustomFrontmatter ? EVENT_OPTION_VALUE : asString(agentRaw),
    );
  }, [agentRaw, agentIsCustomFrontmatter]);

  const showAgentCustomInput =
    agentSelectLocal === EVENT_OPTION_VALUE || agentIsCustomFrontmatter;

  // Local draft for the custom-agent text input so per-keystroke typing
  // composes correctly even when the parent's onChange is a pure spy in
  // tests (the controlled value never round-trips back).
  const [agentCustomText, setAgentCustomText] = useState<string>(
    agentIsCustomFrontmatter ? asString(agentRaw) : '',
  );
  const lastSeenAgentRef = useRef<unknown>(fm.agent);
  useEffect(() => {
    if (fm.agent !== lastSeenAgentRef.current) {
      lastSeenAgentRef.current = fm.agent;
      setAgentCustomText(agentIsCustomFrontmatter ? asString(fm.agent) : '');
    }
  }, [fm.agent, agentIsCustomFrontmatter]);

  // Payload textarea: keep a local draft so transient invalid JSON doesn't
  // wipe the last known good payload. On parse-failure we set aria-invalid
  // and don't propagate payload through onChange.
  const initialPayloadText = useMemo(() => {
    const p = asRecord(fm.payload);
    return p ? JSON.stringify(p, null, 2) : fm.payload == null ? '' : '';
  }, // Only seed on mount + when payload identity changes from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fm.payload]);

  const [payloadText, setPayloadText] = useState(initialPayloadText);
  const [payloadValid, setPayloadValid] = useState(true);

  // Keep payloadText in sync if the parent swaps in a different trigger document.
  const lastSeenPayloadRef = useRef<unknown>(fm.payload);
  useEffect(() => {
    if (fm.payload !== lastSeenPayloadRef.current) {
      lastSeenPayloadRef.current = fm.payload;
      setPayloadText(initialPayloadText);
      setPayloadValid(true);
    }
  }, [fm.payload, initialPayloadText]);

  // event_filter rows — local state mirrors fm.event_filter; parent commits
  // happen via emitFrontmatter whenever rows change.
  const [filterRows, setFilterRows] = useState<FilterRow[]>(
    () => filterToRows(asRecord(fm.event_filter)),
  );

  const scheduleId = useId();
  const eventId = useId();
  const eventKindId = useId();
  const agentId = useId();
  const agentCustomId = useId();
  const payloadId = useId();
  const enabledId = useId();

  function emitFrontmatter(patch: Record<string, unknown>) {
    onChange({
      ...value,
      frontmatter: { ...fm, ...patch },
    });
  }

  function setMode(next: Mode) {
    if (builtin) return;
    if (next === 'schedule') {
      emitFrontmatter({
        schedule: typeof fm.schedule === 'string' ? fm.schedule : '',
        on_event: null,
        event_filter: null,
      });
    } else {
      emitFrontmatter({
        schedule: null,
        on_event:
          typeof fm.on_event === 'string' && fm.on_event !== '' ? fm.on_event : KNOWN_EVENT_KINDS[0],
      });
    }
  }

  function handleCronChange(next: string) {
    if (builtin) return;
    emitFrontmatter({ schedule: next });
  }

  function handleEventChange(next: string) {
    if (builtin) return;
    emitFrontmatter({ on_event: next });
  }

  function handleAgentSelect(next: string) {
    if (builtin) return;
    setAgentSelectLocal(next);
    if (next === EVENT_OPTION_VALUE) {
      // Switch to custom mode. Don't seed `$event.` into frontmatter yet —
      // wait for the user to type a key into the dedicated input, otherwise
      // a transient `$event.` would fail the schema regex.
      // Mark agent as null in frontmatter until the custom input has content
      // so schema parses both states cleanly.
      if (!agentIsCustomFrontmatter) emitFrontmatter({ agent: null });
    } else if (next === '') {
      emitFrontmatter({ agent: null });
    } else {
      emitFrontmatter({ agent: next });
    }
  }

  function handleAgentCustomChange(next: string) {
    if (builtin) return;
    setAgentCustomText(next);
    // Only commit a non-empty value to frontmatter so the schema's
    // `$event.<key>` regex doesn't reject a transient empty/partial draft.
    emitFrontmatter({ agent: next === '' ? null : next });
  }

  function handlePayloadChange(text: string) {
    setPayloadText(text);
    if (text.trim() === '') {
      setPayloadValid(true);
      if (!builtin) emitFrontmatter({ payload: null });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setPayloadValid(true);
        if (!builtin) emitFrontmatter({ payload: parsed as Record<string, unknown> });
      } else {
        // Payload must be an object/record per trigger-schema.
        setPayloadValid(false);
      }
    } catch {
      setPayloadValid(false);
    }
  }

  function handleEnabledChange(next: boolean) {
    // Enabled stays mutable even when builtin === true.
    emitFrontmatter({ enabled: next });
  }

  function updateFilterRow(idx: number, patch: Partial<FilterRow>) {
    if (builtin) return;
    const next = filterRows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    setFilterRows(next);
    emitFrontmatter({ event_filter: rowsToFilter(next) });
  }

  function addFilterRow() {
    if (builtin) return;
    const next = [...filterRows, { key: '', value: '' }];
    setFilterRows(next);
    // Don't commit empty rows to event_filter — wait until the row has a key.
  }

  function removeFilterRow(idx: number) {
    if (builtin) return;
    const next = filterRows.filter((_, i) => i !== idx);
    setFilterRows(next);
    emitFrontmatter({ event_filter: rowsToFilter(next) });
  }

  return (
    <div className="flex flex-col gap-4">
      {builtin ? (
        <div
          role="status"
          className="rounded-md border border-border-light bg-card px-3 py-2 text-xs text-fg-2"
        >
          Builtin trigger — only the Enabled toggle is mutable.
        </div>
      ) : null}

      {/* Mode toggle */}
      <fieldset className="flex flex-col gap-1" disabled={builtin}>
        <legend className="font-mono text-[11px] text-fg-3">mode</legend>
        <div className="flex items-center gap-4">
          <label htmlFor={scheduleId} className="inline-flex items-center gap-2 text-sm text-fg">
            <input
              id={scheduleId}
              type="radio"
              name={`trigger-mode-${scheduleId}`}
              checked={mode === 'schedule'}
              onChange={() => setMode('schedule')}
              disabled={builtin}
              aria-label="Schedule"
            />
            <span>Schedule</span>
          </label>
          <label htmlFor={eventId} className="inline-flex items-center gap-2 text-sm text-fg">
            <input
              id={eventId}
              type="radio"
              name={`trigger-mode-${scheduleId}`}
              checked={mode === 'event'}
              onChange={() => setMode('event')}
              disabled={builtin}
              aria-label="Event"
            />
            <span>Event</span>
          </label>
        </div>
      </fieldset>

      {/* Schedule or Event-specific controls */}
      {mode === 'schedule' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`cron-${scheduleId}`} className="font-mono text-[11px] text-fg-3">
            cron schedule
          </label>
          <CronInput
            id={`cron-${scheduleId}`}
            value={asString(fm.schedule)}
            onChange={handleCronChange}
            disabled={builtin}
            placeholder="0 9 * * *"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={eventKindId} className="font-mono text-[11px] text-fg-3">
              event kind
            </label>
            <select
              id={eventKindId}
              value={asString(fm.on_event) || KNOWN_EVENT_KINDS[0]}
              onChange={(e) => handleEventChange(e.target.value)}
              disabled={builtin}
              aria-label="Event kind"
              className="block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-sm text-fg input-focus disabled:opacity-50"
            >
              {KNOWN_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          {/* event_filter rows */}
          <div className="flex flex-col gap-2">
            <div className="font-mono text-[11px] text-fg-3">event filters</div>
            {filterRows.length === 0 ? (
              <p className="text-xs text-fg-3">
                No filters — trigger fires on every <code className="font-mono">{asString(fm.on_event) || 'event'}</code>.
              </p>
            ) : null}
            {filterRows.map((row, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => updateFilterRow(idx, { key: e.target.value })}
                  placeholder="key"
                  disabled={builtin}
                  aria-label={`Filter key ${idx + 1}`}
                  className="block w-1/3 rounded-md border border-border-light bg-shell px-2 py-1 font-mono text-sm text-fg input-focus disabled:opacity-50"
                />
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => updateFilterRow(idx, { value: e.target.value })}
                  placeholder="value"
                  disabled={builtin}
                  aria-label={`Filter value ${idx + 1}`}
                  className="block flex-1 rounded-md border border-border-light bg-shell px-2 py-1 font-mono text-sm text-fg input-focus disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => removeFilterRow(idx)}
                  disabled={builtin}
                  aria-label={`Remove filter ${idx + 1}`}
                  className="rounded-sm px-2 py-1 text-fg-3 hover:bg-card hover:text-fg disabled:opacity-50"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addFilterRow}
              disabled={builtin}
              className="self-start rounded-sm px-2 py-1 text-xs text-fg-3 hover:bg-card hover:text-fg-2 disabled:opacity-50"
            >
              + Add filter
            </button>
          </div>
        </div>
      )}

      {/* Agent select */}
      <div className="flex flex-col gap-1">
        <label htmlFor={agentId} className="font-mono text-[11px] text-fg-3">
          agent
        </label>
        <select
          id={agentId}
          value={agentSelectLocal}
          onChange={(e) => handleAgentSelect(e.target.value)}
          disabled={builtin}
          aria-label="Agent"
          className="block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-sm text-fg input-focus disabled:opacity-50"
        >
          <option value="">— none —</option>
          {agents.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.slug}
            </option>
          ))}
          <option value={EVENT_OPTION_VALUE}>— event field —</option>
        </select>
        {showAgentCustomInput ? (
          <input
            id={agentCustomId}
            type="text"
            value={agentCustomText}
            onChange={(e) => handleAgentCustomChange(e.target.value)}
            disabled={builtin}
            placeholder="$event.assignee_slug"
            aria-label="Agent ($event field)"
            className={cn(
              'mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 font-mono text-sm text-fg input-focus disabled:opacity-50',
            )}
          />
        ) : null}
        {agentRaw == null && !showAgentCustomInput ? (
          <p className="mt-1 text-[11px] leading-snug text-fg-3">
            No agent — trigger has no executor (valid for internal actions).
          </p>
        ) : null}
      </div>

      {/* JSON payload */}
      <div className="flex flex-col gap-1">
        <label htmlFor={payloadId} className="font-mono text-[11px] text-fg-3">
          payload (JSON)
        </label>
        <textarea
          id={payloadId}
          value={payloadText}
          onChange={(e) => handlePayloadChange(e.target.value)}
          disabled={builtin}
          rows={6}
          spellCheck={false}
          aria-label="Payload"
          aria-invalid={!payloadValid}
          placeholder='{"key": "value"}'
          className={cn(
            'block w-full rounded-md border border-border-light bg-shell px-3 py-2 font-mono text-xs text-fg input-focus disabled:opacity-50',
            !payloadValid && 'border-danger',
          )}
        />
        {!payloadValid ? (
          <p className="text-xs text-danger">Invalid JSON — fix or clear to save.</p>
        ) : null}
      </div>

      {/* Enabled toggle (always interactive — even when builtin) */}
      <label htmlFor={enabledId} className="inline-flex items-center gap-2 text-sm text-fg">
        <input
          id={enabledId}
          type="checkbox"
          checked={enabled}
          onChange={(e) => handleEnabledChange(e.target.checked)}
          aria-label="Enabled"
        />
        <span>Enabled</span>
      </label>
    </div>
  );
}
