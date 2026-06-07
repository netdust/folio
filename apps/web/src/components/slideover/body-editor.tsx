import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { clipboard } from '@milkdown/plugin-clipboard';
import { insert, replaceRange } from '@milkdown/utils';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { debounce } from '../../lib/debounce.ts';
import { SlashMenu } from './slash-menu.tsx';
import { WikiMenu } from './wiki-menu.tsx';
import { BodyToolbar } from './body-toolbar.tsx';
import { matchWikiTrigger, replaceWikiToken } from '../../lib/wiki-trigger.ts';
import { captureSlashTokenRange, replaceCapturedRange } from '../../lib/slash-capture.ts';
import { type CompletionAction, completeAi } from '../../lib/api/ai-complete.ts';
import { ApiError } from '../../lib/api/client.ts';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { SlashContext } from '../../lib/slash-registry.ts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  documents?: DocumentSummary[];
  aiConfigured?: boolean;
  /** Workspace slug — required for the AI slash commands (`/draft` etc.). When
   *  absent the AI commands stay inert (the registry already gates on
   *  aiConfigured). */
  wslug?: string;
  /** Current document title — passed to /draft so it can draft from the title. */
  title?: string;
  /** When true, render the formatting toolbar above the editor. Used for
   *  wiki pages where the slideover doesn't carry a frontmatter form. */
  showToolbar?: boolean;
}

interface SlashState {
  open: boolean;
  query: string;
  rect: { top: number; left: number };
}

function MilkdownEditor({
  value,
  onChange,
  readOnly,
  documents = [],
  aiConfigured = false,
  wslug,
  title,
  wrapperRef,
}: Props & { wrapperRef: React.RefObject<HTMLDivElement | null> }) {
  const valueRef = useRef(value);
  valueRef.current = value;
  // Keep wslug/title current without re-creating slashCtx (getter-backed, like
  // documents/aiConfigured).
  const wslugRef = useRef(wslug);
  wslugRef.current = wslug;
  const titleRef = useRef(title);
  titleRef.current = title;

  // useRef-stable debounce: stable across renders, doesn't recreate on onChange change
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const debouncedOnChange = useRef(debounce((md: string) => onChangeRef.current(md), 400)).current;
  useEffect(() => () => debouncedOnChange.cancel(), [debouncedOnChange]);

  const [slash, setSlash] = useState<SlashState>({ open: false, query: '', rect: { top: 0, left: 0 } });
  // `[[` wiki-link trigger — independent of the `/` slash trigger (different
  // chars, mutually exclusive in practice). Mirrors the slash machinery.
  const [wiki, setWiki] = useState<SlashState>({ open: false, query: '', rect: { top: 0, left: 0 } });

  // The live Editor instance — resolved inside MilkdownProvider exactly as
  // BodyToolbar does. Used by the AI slash path to PARSE the result through the
  // editor (replaceRange) instead of poking raw markdown into a DOM text node.
  const [editorLoading, getEditor] = useInstance();

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, valueRef.current);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => !readOnly,
        }));
        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
          // Guard: skip echo-back of the initial value
          if (md !== valueRef.current) debouncedOnChange(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(clipboard),
  );

  // Slash detection: listen for keystrokes inside the editor DOM.
  // Use wrapperRef to scope queries to this specific editor instance (Adaptation 5).
  useEffect(() => {
    const attach = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return false;
      const dom = wrapper.querySelector('.ProseMirror') as HTMLElement | null;
      if (!dom) return false;

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
          // startContainer may not support setStart with that offset; skip
          return;
        }
        const beforeText = beforeRange.toString();

        const m = beforeText.match(/(?:^|\s)\/([\w-]*)$/);
        if (m) {
          const rect = range.getBoundingClientRect();
          setSlash({ open: true, query: m[1] ?? '', rect: { top: rect.bottom + 4, left: rect.left } });
        } else {
          setSlash((s) => (s.open ? { ...s, open: false } : s));
        }

        const wikiQuery = matchWikiTrigger(beforeText);
        if (wikiQuery !== null) {
          const rect = range.getBoundingClientRect();
          setWiki({ open: true, query: wikiQuery, rect: { top: rect.bottom + 4, left: rect.left } });
        } else {
          setWiki((w) => (w.open ? { ...w, open: false } : w));
        }
      };

      dom.addEventListener('input', onInput);
      return () => dom.removeEventListener('input', onInput);
    };

    // Defer once to let Milkdown finish mounting the ProseMirror DOM.
    // Capture the listener cleanup so it runs on unmount even if the timer already fired.
    let listenerCleanup: (() => void) | undefined;
    const timer = setTimeout(() => {
      const result = attach();
      if (typeof result === 'function') listenerCleanup = result;
    }, 0);

    return () => {
      clearTimeout(timer);
      listenerCleanup?.();
    };
  }, [wrapperRef]);

  // Build SlashContext using wrapperRef-scoped DOM queries
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const aiConfiguredRef = useRef(aiConfigured);
  aiConfiguredRef.current = aiConfigured;

  const getProseDOM = () =>
    (wrapperRef.current?.querySelector('.ProseMirror') as HTMLElement | null) ?? null;

  // Read the live ProseMirror view out of the editor instance (the same ctx
  // BodyToolbar reaches via callCommand). Returns null before the editor is
  // ready or if the view ctx isn't populated yet. The captured-range logic in
  // lib/slash-capture.ts only reads `state.selection` + `state.doc`.
  const getEditorView = (
    editor: ReturnType<typeof getEditor> | null,
  ): import('../../lib/slash-capture.ts').SlashTokenView | null => {
    if (!editor) return null;
    try {
      return editor.ctx.get(editorViewCtx) as import('../../lib/slash-capture.ts').SlashTokenView;
    } catch {
      return null;
    }
  };

  // Editor ACTION factory: PARSE `markdown` through the editor and place it
  // over the captured ProseMirror `{from, to}` range. Composed from two
  // @milkdown/utils macros inside ONE editor action (no new deps, one ctx):
  //
  //   1. replaceRange('', range) — delete the `/draft` token, collapsing the
  //      selection onto `range.from`. (Empty markdown ⇒ this is the whole op:
  //      orphaned-token cleanup, finding 213.)
  //   2. insert(markdown) — insert at the now-collapsed cursor. With a collapsed
  //      selection `insert` uses a CLOSED slice, so a leading `# Heading` lands
  //      as a real H1 block instead of flattening into the host paragraph the
  //      token lived in (the bug `replaceRange` alone would reintroduce).
  const parseInsertOverRange =
    (markdown: string, range: { from: number; to: number }) =>
    (ctx: Parameters<ReturnType<typeof replaceRange>>[0]) => {
      replaceRange('', range)(ctx);
      if (markdown.length > 0) insert(markdown)(ctx);
    };

  // Guards against a double-fire of the async AI completion (finding 193): the
  // slash menu can re-invoke `aiComplete` while a request is still in flight.
  const aiInFlightRef = useRef(false);

  const slashCtx: SlashContext = {
    get documents() { return documentsRef.current; },
    get aiConfigured() { return aiConfiguredRef.current; },
    insert: (text: string) => {
      const dom = getProseDOM();
      if (!dom) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = (node as Text).data;
        const at = txt.lastIndexOf('/', range.startOffset - 1);
        if (at >= 0) {
          const replaceRange = document.createRange();
          replaceRange.setStart(node, at);
          replaceRange.setEnd(node, range.startOffset);
          replaceRange.deleteContents();
          (node as Text).insertData(at, text);
        }
      }
      // Fire input so Milkdown picks up the change
      dom.dispatchEvent(new InputEvent('input', { bubbles: true }));
    },
    replace: (markdown: string) => {
      // For v1 /link, replace === insert (swap the slash token for [[slug]])
      slashCtx.insert(markdown);
    },
    notify: (msg, kind = 'info') => {
      if (kind === 'warning') toast.warning(msg);
      else toast.info(msg);
    },
    aiComplete: async (action: CompletionAction) => {
      const ws = wslugRef.current;
      if (!ws) {
        toast.warning('AI is not available here');
        return;
      }
      // Single-flight guard (finding 193): the slash menu can re-fire while a
      // request is still streaming. Ignore the second invocation.
      if (aiInFlightRef.current) {
        toast.info('AI is already working…');
        return;
      }

      // POSITION CAPTURE (findings 210/201/211/171). Unlike the synchronous
      // `/link` path, `aiComplete` awaits the provider for SECONDS, during which
      // the user can move the caret, type, or delete the `/draft` token. We
      // therefore snapshot the slash-token's ProseMirror position RANGE NOW —
      // before the await — and replace THAT captured range on resolve, not a
      // fresh live selection (which would land the text at the moved caret or
      // silently no-op). See lib/slash-capture.ts.
      const editor = editorLoading ? null : getEditor();
      const captured = captureSlashTokenRange(getEditorView(editor));

      // Replace the captured slash-token range with PARSED markdown via the
      // editor's `replaceRange` action (empty `markdown` deletes the token).
      // `replaceRange` runs the markdown through the editor's parser, so `#`,
      // lists and paragraphs become real ProseMirror nodes instead of literal
      // text (the root-cause fix). Returns false when the captured range no
      // longer fits the (edited) document — e.g. the user deleted the block.
      const placeResult = (markdown: string): boolean =>
        replaceCapturedRange(editor, getEditorView(editor), captured, markdown, parseInsertOverRange);

      // Capture the body BEFORE the slash token is mutated. `/draft` works from
      // the title even when the body is empty; the others transform the body.
      const content = valueRef.current;
      const verb = action === 'decompose' ? 'Decomposing' : action === 'summarize' ? 'Summarizing' : 'Drafting';
      const dismiss = toast.loading(`${verb}…`);
      aiInFlightRef.current = true;
      try {
        const { text } = await completeAi(ws, {
          action,
          content,
          title: titleRef.current,
        });
        toast.dismiss(dismiss);
        // Replace the CAPTURED slash token with the generated markdown. If the
        // captured node was detached (user deleted the block), warn rather than
        // silently dropping the result.
        const placed = placeResult(text);
        if (!placed) toast.warning("Couldn't place the AI result — the text moved.");
      } catch (err) {
        toast.dismiss(dismiss);
        // Remove the orphaned slash token (finding 213) so the editor isn't left
        // with a stray `/draft`, consistent with the success path.
        placeResult('');
        const code =
          err instanceof ApiError &&
          err.body &&
          typeof err.body === 'object' &&
          'error' in err.body
            ? (err.body as { error?: { code?: string } }).error?.code
            : undefined;
        if (code === 'AI_REFUSED') toast.warning('The AI declined to complete this request.');
        else if (code === 'AI_EMPTY_RESPONSE') toast.warning('The AI returned an empty response.');
        else toast.warning('AI request failed');
      } finally {
        aiInFlightRef.current = false;
      }
    },
  };

  // Insert a `[[slug]]` wiki-link, replacing the `[[<query>` token at the
  // caret. Mirrors slashCtx.insert's range logic but locates the `[[` opener
  // instead of the last `/`.
  const insertWikiLink = (slug: string) => {
    const dom = getProseDOM();
    if (!dom) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = (node as Text).data;
      // Pure helper computes the range to replace — including an orphaned
      // trailing `]]` after the caret — so we never produce `[[slug]]]]`.
      const repl = replaceWikiToken(txt, range.startOffset, slug);
      if (repl) {
        const replaceRange = document.createRange();
        replaceRange.setStart(node, repl.start);
        replaceRange.setEnd(node, repl.end);
        replaceRange.deleteContents();
        (node as Text).insertData(repl.start, `[[${slug}]]`);
      }
    }
    dom.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };

  return (
    <>
      <Milkdown />
      {slash.open ? (
        <SlashMenu
          ctx={slashCtx}
          query={slash.query}
          rect={slash.rect}
          onClose={() => setSlash((s) => ({ ...s, open: false }))}
        />
      ) : null}
      {wiki.open ? (
        <WikiMenu
          documents={documentsRef.current}
          query={wiki.query}
          rect={wiki.rect}
          onSelect={(slug) => {
            insertWikiLink(slug);
            setWiki((w) => ({ ...w, open: false }));
          }}
          onClose={() => setWiki((w) => ({ ...w, open: false }))}
        />
      ) : null}
    </>
  );
}

export function BodyEditor(props: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { showToolbar, ...editorProps } = props;
  return (
    <MilkdownProvider>
      {showToolbar ? <BodyToolbar /> : null}
      <div className="folio-milkdown" ref={wrapperRef}>
        <MilkdownEditor {...editorProps} wrapperRef={wrapperRef} />
      </div>
    </MilkdownProvider>
  );
}
