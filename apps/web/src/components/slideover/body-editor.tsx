import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { clipboard } from '@milkdown/plugin-clipboard';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { debounce } from '../../lib/debounce.ts';
import { SlashMenu } from './slash-menu.tsx';
import { BodyToolbar } from './body-toolbar.tsx';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { SlashContext } from '../../lib/slash-registry.ts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  documents?: DocumentSummary[];
  aiConfigured?: boolean;
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
  wrapperRef,
}: Props & { wrapperRef: React.RefObject<HTMLDivElement | null> }) {
  const valueRef = useRef(value);
  valueRef.current = value;

  // useRef-stable debounce: stable across renders, doesn't recreate on onChange change
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const debouncedOnChange = useRef(debounce((md: string) => onChangeRef.current(md), 400)).current;
  useEffect(() => () => debouncedOnChange.cancel(), [debouncedOnChange]);

  const [slash, setSlash] = useState<SlashState>({ open: false, query: '', rect: { top: 0, left: 0 } });

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
