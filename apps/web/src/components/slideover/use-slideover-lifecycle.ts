import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { Document } from '../../lib/api/documents.ts';

export interface InnerActions {
  save: () => Promise<void>;
  discard: () => void;
}

/**
 * The shared, param-keyed parent-side lifecycle for BOTH slideovers
 * (document-slideover on `?doc=`, workspace-document-slideover on `?wdoc=`).
 *
 * It owns the bits that were character-identical between the two forks:
 *  - the mirrored `dirty`/`saving` flags + the imperative `actionsRef`
 *  - the dirty-slug LATCH (set when the inner reports dirty, released on clean)
 *  - the close + doc-SWITCH guard (intercept-during-render + the effect-driven
 *    prompt that reverts the URL to the dirty doc and queues the intended switch)
 *  - the Cmd/Ctrl-S "save the buffered draft when dirty" shortcut
 *  - the remount `innerKey` (`${doc.id}:${doc.updatedAt}`)
 *
 * The ONE thing that threads through that whole core and differs between the two
 * is the URL search param the slideover lives on — so it is a parameter
 * (`paramKey`), not flattened. Everything that DIVERGES (data source, tab
 * seeding, toolbar contents, width/resize, the inner renderer) stays OUT of this
 * hook — owned by each wrapper or passed to SlideoverShell.
 */
export function useSlideoverLifecycle({
  doc,
  paramKey,
}: {
  doc: Document | undefined;
  paramKey: 'doc' | 'wdoc';
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const currentSlug = (search[paramKey] as string | undefined) ?? null;
  const open = !!currentSlug;

  // Dirtiness + saving are OWNED by the keyed inner (it owns the draft) and
  // MIRRORED up here so the header Save button + close/switch guard can read
  // them. Imperative save/discard come back via the actions ref.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const actionsRef = useRef<InnerActions | null>(null);

  // ----- close + doc-switch guard ------------------------------------------
  // Because the inner remounts on a doc switch (clearing its own isDirty before
  // any effect could observe it), we LATCH the slug whose buffer was dirty so
  // the switch still routes through the prompt. The latch is set whenever the
  // inner reports dirty, released when it reports clean for the loaded doc.
  const dirtySlugRef = useRef<string | null>(null);
  if (doc?.slug && dirty) dirtySlugRef.current = doc.slug;
  else if (doc?.slug && doc.slug === dirtySlugRef.current && !dirty) dirtySlugRef.current = null;

  const [prompting, setPrompting] = useState(false);
  const queuedRef = useRef<(() => void) | null>(null);
  const guard = (action: () => void) => {
    if (!dirty && dirtySlugRef.current === null) {
      action();
      return;
    }
    queuedRef.current = action;
    setPrompting(true);
  };
  const proceed = () => {
    const action = queuedRef.current;
    queuedRef.current = null;
    setPrompting(false);
    action?.();
  };
  const cancelPrompt = () => {
    queuedRef.current = null;
    setPrompting(false);
  };

  const doClose = () => {
    const { [paramKey]: _removed, ...next } = search;
    void navigate({ to: '.', search: next });
  };
  const close = () => guard(doClose);

  // Guard doc-SWITCH (not just close): if the URL param flips to a DIFFERENT
  // slug while the buffer is dirty, intercept — revert the URL to the latched
  // (still dirty) doc and prompt. The guard's queued action re-applies the
  // intended switch once the buffer is resolved (Save remounts the inner clean,
  // Discard resets it).
  //
  // Detection runs DURING render (not in a [search[paramKey]] effect): switching
  // doc unloads the old doc and remounts the inner clean, so by the time an
  // effect fires both `dirty` AND the loaded slug have already moved on.
  // Comparing the committed param to the previous one during render catches the
  // flip while dirtySlugRef still names the dirty doc.
  const prevSlugRef = useRef<string | undefined>(currentSlug ?? undefined);
  const pendingSwitchRef = useRef<string | null>(null);
  if (prevSlugRef.current !== (currentSlug ?? undefined)) {
    const incoming = currentSlug ?? undefined;
    const dirtySlug = dirtySlugRef.current;
    if (incoming && dirtySlug && incoming !== dirtySlug) {
      pendingSwitchRef.current = incoming;
    }
    prevSlugRef.current = incoming;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: dirty-doc switch guard — must run ONLY on [currentSlug] change; navigate/guard/search read live, deliberately omitted to avoid breaking the unsaved-changes race guard
  useEffect(() => {
    const incoming = pendingSwitchRef.current;
    const dirtySlug = dirtySlugRef.current;
    pendingSwitchRef.current = null;
    if (!incoming || !dirtySlug || incoming === dirtySlug) return;
    // Revert URL to the dirty doc and queue the intended switch behind the guard.
    void navigate({ to: '.', search: { ...search, [paramKey]: dirtySlug } });
    guard(() => navigate({ to: '.', search: { ...search, [paramKey]: incoming } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlug]);

  // Cmd/Ctrl-S saves the buffered draft when dirty (delegates to the inner).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (dirty && !saving) void actionsRef.current?.save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dirty, saving]);

  // Shared key — the crux of the refetch-stomp fix: a doc switch OR a post-save
  // updatedAt bump remounts the inner → a fresh useDocumentDraft seed from the
  // loaded doc. The inner is null until a REAL doc loads, so it never sees the
  // loading placeholder.
  const innerKey = doc ? `${doc.id}:${doc.updatedAt}` : null;

  return {
    open,
    slug: currentSlug,
    dirty,
    setDirty,
    saving,
    setSaving,
    actionsRef,
    innerKey,
    prompting,
    setPrompting,
    guard,
    proceed,
    cancelPrompt,
    close,
  };
}
