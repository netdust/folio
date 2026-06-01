import { useEffect, useMemo, useRef, useState } from 'react';

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
  const seed = useMemo<DraftState>(
    () => ({ body: doc.body, frontmatter: doc.frontmatter }),
    [doc.body, doc.frontmatter],
  );
  const [draft, setDraft] = useState<DraftState>(seed);

  // Re-seed on doc.id (switch) or doc.updatedAt (post-save) change.
  const seedKeyRef = useRef<string>(`${doc.id}::${doc.updatedAt}`);
  useEffect(() => {
    const key = `${doc.id}::${doc.updatedAt}`;
    if (seedKeyRef.current !== key) {
      seedKeyRef.current = key;
      setDraft({ body: doc.body, frontmatter: doc.frontmatter });
    }
  }, [doc.id, doc.updatedAt, doc.body, doc.frontmatter]);

  const setBody = (body: string) => setDraft((d) => ({ ...d, body }));
  const setFrontmatter = (patch: Record<string, unknown>) =>
    setDraft((d) => ({ ...d, frontmatter: { ...d.frontmatter, ...patch } }));
  const reset = () => setDraft({ body: doc.body, frontmatter: doc.frontmatter });

  const isDirty =
    draft.body !== doc.body ||
    JSON.stringify(draft.frontmatter) !== JSON.stringify(doc.frontmatter);

  const diff = (): { patch: Record<string, unknown>; keys: string[] } => {
    const patch: Record<string, unknown> = {};
    const keys: string[] = [];
    if (draft.body !== doc.body) {
      patch.body = draft.body;
      keys.push('body');
    }
    if (JSON.stringify(draft.frontmatter) !== JSON.stringify(doc.frontmatter)) {
      patch.frontmatter = draft.frontmatter;
      const oldFm = doc.frontmatter;
      const newFm = draft.frontmatter;
      const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);
      for (const k of allKeys) {
        if (JSON.stringify(oldFm[k]) !== JSON.stringify(newFm[k])) keys.push(k);
      }
    }
    return { patch, keys };
  };

  return { draft, setBody, setFrontmatter, isDirty, reset, diff };
}
