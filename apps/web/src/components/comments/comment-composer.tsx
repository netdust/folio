import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { clipboard } from '@milkdown/plugin-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { debounce } from '../../lib/debounce.ts';
import { Button } from '../ui/button.tsx';
import { MentionPicker } from './mention-picker.tsx';
import { WikiLinkPicker } from './wiki-link-picker.tsx';

interface CommentComposerProps {
  workspaceSlug: string;
  projectSlug: string;
  /** Used for the localStorage draft key + future telemetry. */
  parentId: string;
  /** Project ID — needed by MentionPicker for the agent allow-list. */
  projectId: string;
  onSubmit: (body: string) => Promise<void> | void;
  /** Called when Escape is pressed on an empty composer, or when Cancel is clicked. */
  onCollapse?: () => void;
  autoFocus?: boolean;
}

type PickerKind = 'mention' | 'wiki';

interface PickerState {
  kind: PickerKind;
  query: string;
  rect: { top: number; left: number };
}

function draftKey(parentId: string) {
  return `folio:comment-draft:${parentId}`;
}

function readDraft(parentId: string): string {
  try {
    return localStorage.getItem(draftKey(parentId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(parentId: string, body: string) {
  try {
    if (body.trim() === '') localStorage.removeItem(draftKey(parentId));
    else localStorage.setItem(draftKey(parentId), body);
  } catch {
    // localStorage may be unavailable (private mode, etc.) — swallow.
  }
}

function clearDraft(parentId: string) {
  try {
    localStorage.removeItem(draftKey(parentId));
  } catch {
    // no-op
  }
}

interface InnerEditorProps {
  initialValue: string;
  onChange: (next: string) => void;
  /** Imperative handle: set the editor content to `next`. */
  resetSignal: number;
  resetTo: string;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  autoFocus?: boolean;
}

function MilkdownCommentEditor({
  initialValue,
  onChange,
  resetSignal,
  resetTo,
  wrapperRef,
  autoFocus,
}: InnerEditorProps) {
  const initialValueRef = useRef(initialValue);
  // Don't update initialValueRef after mount — Milkdown owns the content from then on.

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // editorRef holds the Milkdown Editor instance so we can imperatively reset content.
  const editorInstanceRef = useRef<Editor | null>(null);

  useEditor((root) => {
    const ed = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialValueRef.current);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => true,
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
          if (md !== initialValueRef.current) onChangeRef.current(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(clipboard);
    editorInstanceRef.current = ed;
    return ed;
  });

  // When resetSignal increments, rebuild content by toggling defaultValueCtx.
  // String-replace + content-reset is the v1 strategy for trigger replacement
  // (caret jumps to end; acceptable per spec).
  useEffect(() => {
    if (resetSignal === 0) return;
    const dom = wrapperRef.current?.querySelector('.ProseMirror') as HTMLElement | null;
    if (!dom) return;
    // Replace the DOM with a paragraph containing the desired text and fire input.
    // This is a pragmatic v1 approach — Milkdown will re-parse on its next round-trip.
    dom.innerHTML = `<p>${resetTo.replace(/</g, '&lt;')}</p>`;
    dom.dispatchEvent(new InputEvent('input', { bubbles: true }));
    // Update the ref so the listener guard accepts subsequent edits.
    initialValueRef.current = resetTo;
    // Notify outer state immediately (the listener may or may not fire reliably).
    onChangeRef.current(resetTo);
  }, [resetSignal, resetTo, wrapperRef]);

  // Auto-focus when requested.
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => {
      const dom = wrapperRef.current?.querySelector('.ProseMirror') as HTMLElement | null;
      dom?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [autoFocus, wrapperRef]);

  return <Milkdown />;
}

export function CommentComposer({
  workspaceSlug,
  projectSlug,
  parentId,
  projectId,
  onSubmit,
  onCollapse,
  autoFocus,
}: CommentComposerProps) {
  // Initial value: read from localStorage on mount (synchronous via useState init fn).
  const initialDraft = (() => {
    try {
      return readDraft(parentId);
    } catch {
      return '';
    }
  })();

  const [body, setBody] = useState<string>(initialDraft);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetTo, setResetTo] = useState<string>(initialDraft);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef(body);
  const prevPickerRef = useRef<PickerState | null>(null);
  bodyRef.current = body;

  // Debounced draft writer. Cancel on unmount.
  const debouncedSave = useRef(
    debounce((next: string) => writeDraft(parentId, next), 300),
  ).current;
  useEffect(() => () => debouncedSave.cancel(), [debouncedSave]);

  const handleChange = useCallback(
    (next: string) => {
      setBody(next);
      debouncedSave(next);
    },
    [debouncedSave],
  );

  // Picker open: focus the picker root so its keydown handler receives Arrow/Enter/Escape.
  // Picker close: return focus to the editor so the user can keep typing without a re-click.
  useEffect(() => {
    const prev = prevPickerRef.current;
    prevPickerRef.current = picker;

    if (picker) {
      // Transition: closed → open. Defer focus to after the picker DOM mounts.
      const t = setTimeout(() => pickerRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }

    if (prev && !picker) {
      // Transition: open → closed. Return focus to the ProseMirror editor.
      const t = setTimeout(() => {
        const dom = wrapperRef.current?.querySelector('.ProseMirror') as HTMLElement | null;
        dom?.focus();
      }, 0);
      return () => clearTimeout(t);
    }

    return undefined;
  }, [picker]);

  // Listen for `@` / `[[` triggers on the ProseMirror DOM.
  useEffect(() => {
    const attach = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return undefined;
      const dom = wrapper.querySelector('.ProseMirror') as HTMLElement | null;
      if (!dom) return undefined;

      const onInput = () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const beforeRange = range.cloneRange();
        beforeRange.collapse(true);
        const startOffset = Math.max(0, beforeRange.startOffset - 50);
        try {
          beforeRange.setStart(beforeRange.startContainer, startOffset);
        } catch {
          return;
        }
        const beforeText = beforeRange.toString();

        // `[[` takes priority over `@` (less ambiguous, longer trigger).
        const wikiMatch = beforeText.match(/\[\[([a-z0-9-]*)$/);
        if (wikiMatch) {
          const rect = range.getBoundingClientRect();
          setPicker({
            kind: 'wiki',
            query: wikiMatch[1] ?? '',
            rect: { top: rect.bottom + 4, left: rect.left },
          });
          return;
        }
        const mentionMatch = beforeText.match(/(?:^|\s)@([a-z0-9-]*)$/);
        if (mentionMatch) {
          const rect = range.getBoundingClientRect();
          setPicker({
            kind: 'mention',
            query: mentionMatch[1] ?? '',
            rect: { top: rect.bottom + 4, left: rect.left },
          });
          return;
        }
        setPicker(null);
      };

      dom.addEventListener('input', onInput);
      return () => dom.removeEventListener('input', onInput);
    };

    let cleanup: (() => void) | undefined;
    const timer = setTimeout(() => {
      const result = attach();
      if (typeof result === 'function') cleanup = result;
    }, 0);

    return () => {
      clearTimeout(timer);
      cleanup?.();
    };
  }, []);

  const doSubmit = useCallback(async () => {
    const trimmed = bodyRef.current.trim();
    if (!trimmed) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(bodyRef.current);
      // Success: clear body + draft.
      debouncedSave.cancel();
      clearDraft(parentId);
      setBody('');
      setResetTo('');
      setResetSignal((n) => n + 1);
    } catch {
      // Submit failure: leave body + draft intact so the user can retry.
      // The caller's onSubmit is responsible for surfacing the error (toast etc).
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, parentId, submitting, debouncedSave]);

  const doCancel = useCallback(() => {
    debouncedSave.cancel();
    clearDraft(parentId);
    setBody('');
    setResetTo('');
    setResetSignal((n) => n + 1);
    onCollapse?.();
  }, [onCollapse, parentId, debouncedSave]);

  // Composer-level keydown: Cmd/Ctrl+Enter submits; Escape on empty calls onCollapse.
  // If the picker is open, Escape is handled by the picker (which has focus).
  const onComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void doSubmit();
        return;
      }
      if (e.key === 'Escape' && !picker) {
        if (bodyRef.current.trim() === '') {
          e.preventDefault();
          onCollapse?.();
        }
      }
    },
    [doSubmit, onCollapse, picker],
  );

  // Replace the most recent trigger token with the chosen text + close picker.
  const replaceTrigger = useCallback(
    (replacement: string) => {
      const current = bodyRef.current;
      let next = current;
      if (picker?.kind === 'mention') {
        // Replace last `@<query>` (or bare `@`) with the replacement.
        next = current.replace(/(^|\s)@([a-z0-9-]*)$/, `$1${replacement}`);
      } else if (picker?.kind === 'wiki') {
        next = current.replace(/\[\[([a-z0-9-]*)$/, replacement);
      }
      if (next === current) {
        // Fall back: append replacement at the end (cursor was lost or pattern didn't match).
        next = current + replacement;
      }
      setBody(next);
      setResetTo(next);
      setResetSignal((n) => n + 1);
      debouncedSave(next);
      setPicker(null);
    },
    [picker, debouncedSave],
  );

  const onMentionSelect = useCallback(
    (target: { type: 'agent' | 'user'; value: string }) => {
      // `@<value> ` — value is slug (agent) or email-localpart (user).
      replaceTrigger(`@${target.value} `);
    },
    [replaceTrigger],
  );

  const onWikiSelect = useCallback(
    (target: { slug: string; title: string }) => {
      replaceTrigger(`[[${target.slug}]] `);
    },
    [replaceTrigger],
  );

  const submitDisabled = body.trim() === '' || submitting;

  return (
    <div
      data-testid="comment-composer"
      onKeyDown={onComposerKeyDown}
      className="flex flex-col gap-2"
    >
      <div ref={wrapperRef} className="folio-milkdown folio-milkdown--compact rounded-md border border-border-light bg-content">
        <MilkdownProvider>
          <MilkdownCommentEditor
            initialValue={initialDraft}
            onChange={handleChange}
            resetSignal={resetSignal}
            resetTo={resetTo}
            wrapperRef={wrapperRef}
            autoFocus={autoFocus}
          />
        </MilkdownProvider>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={doCancel}
          data-testid="comment-composer-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void doSubmit()}
          disabled={submitDisabled}
          loading={submitting}
          data-testid="comment-composer-submit"
        >
          Comment <span className="ml-1 opacity-70" aria-hidden="true">⌘↵</span>
        </Button>
      </div>

      {picker ? (
        <div
          ref={pickerRef}
          tabIndex={-1}
          style={{ position: 'fixed', top: picker.rect.top, left: picker.rect.left, zIndex: 50 }}
        >
          {picker.kind === 'mention' ? (
            <MentionPicker
              workspaceSlug={workspaceSlug}
              projectId={projectId}
              query={picker.query}
              onSelect={onMentionSelect}
              onClose={() => setPicker(null)}
            />
          ) : (
            <WikiLinkPicker
              workspaceSlug={workspaceSlug}
              projectSlug={projectSlug}
              query={picker.query}
              onSelect={onWikiSelect}
              onClose={() => setPicker(null)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
