import { useRef, useState } from 'react';
import { SERVER_MANAGED_FRONTMATTER_KEYS } from '@folio/shared';

const MANAGED = new Set<string>(SERVER_MANAGED_FRONTMATTER_KEYS);

/**
 * Drop server-managed keys (api_token_id, last_touched_at, …) so they never
 * count toward dirtiness or get echoed back on a PATCH (the agent/trigger
 * schemas are .strict() and reject them; the server drops them on merge).
 */
function editableFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!MANAGED.has(k)) out[k] = v;
  }
  return out;
}

interface DraftDoc {
  id: string;
  updatedAt: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

interface DraftState {
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface DocumentDraft {
  draft: DraftState;
  setBody: (body: string) => void;
  /** Shallow-merges the patch into draft.frontmatter. */
  setFrontmatter: (patch: Record<string, unknown>) => void;
  isDirty: boolean;
  /** Discard edits and re-seed from the current doc. */
  reset: () => void;
  /** Changed top-level fields; frontmatter keys diffed per-key. */
  diff: () => { patch: Record<string, unknown>; keys: string[] };
}

/**
 * Buffered draft for a document's editable body + frontmatter. Title and status
 * are NOT part of the buffer — they commit immediately at their own call sites.
 *
 * Re-seeds whenever doc.id changes (the user switched documents) OR doc.updatedAt
 * changes (a save returned a fresh version). The slideover is mounted
 * persistently at the layout, so the hook can't rely on remount to re-seed.
 */
export function useDocumentDraft(doc: DraftDoc): DocumentDraft {
  const [draft, setDraft] = useState<DraftState>(() => ({
    body: doc.body,
    frontmatter: doc.frontmatter,
  }));

  // Re-seed on doc.id (switch) or doc.updatedAt (post-save) change. This runs
  // DURING render (the React "derive state from a changing key" pattern), not in
  // an effect, so there's no empty-draft frame: a mount-only body editor keyed on
  // the same identity reads the freshly-seeded value, not the stale fallback the
  // parent passes while the doc is still loading.
  const seedKeyRef = useRef<string>(`${doc.id}::${doc.updatedAt}`);
  const currentKey = `${doc.id}::${doc.updatedAt}`;
  if (seedKeyRef.current !== currentKey) {
    seedKeyRef.current = currentKey;
    setDraft({ body: doc.body, frontmatter: doc.frontmatter });
  }

  const setBody = (body: string) => setDraft((d) => ({ ...d, body }));
  const setFrontmatter = (patch: Record<string, unknown>) =>
    setDraft((d) => ({ ...d, frontmatter: { ...d.frontmatter, ...patch } }));
  const reset = () => setDraft({ body: doc.body, frontmatter: doc.frontmatter });

  // Compare + send only the EDITABLE frontmatter (server-managed keys excluded),
  // so a doc's own injected keys (api_token_id, last_touched_at, …) never make
  // the buffer look dirty and never get echoed back on a PATCH.
  const draftFm = editableFrontmatter(draft.frontmatter);
  const docFm = editableFrontmatter(doc.frontmatter);

  const isDirty =
    draft.body !== doc.body || JSON.stringify(draftFm) !== JSON.stringify(docFm);

  const diff = (): { patch: Record<string, unknown>; keys: string[] } => {
    const patch: Record<string, unknown> = {};
    const keys: string[] = [];
    if (draft.body !== doc.body) {
      patch.body = draft.body;
      keys.push('body');
    }
    if (JSON.stringify(draftFm) !== JSON.stringify(docFm)) {
      patch.frontmatter = draftFm;
      const allKeys = new Set([...Object.keys(docFm), ...Object.keys(draftFm)]);
      for (const k of allKeys) {
        if (JSON.stringify(docFm[k]) !== JSON.stringify(draftFm[k])) keys.push(k);
      }
    }
    return { patch, keys };
  };

  return { draft, setBody, setFrontmatter, isDirty, reset, diff };
}
