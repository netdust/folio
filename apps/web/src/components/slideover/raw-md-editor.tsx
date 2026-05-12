import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { useEffect, useRef } from 'react';
import { debounce } from '../../lib/debounce.ts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}

export function RawMdEditor({ value, onChange, readOnly }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const debouncedOnChange = useRef(debounce((md: string) => onChangeRef.current(md), 400)).current;

  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((v) => {
          if (v.docChanged) {
            const next = v.state.doc.toString();
            if (next !== valueRef.current) debouncedOnChange(next);
          }
        }),
        EditorView.theme({
          '&': { fontSize: '13px', fontFamily: 'var(--font-mono)', height: '100%' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            borderRight: '1px solid var(--color-border-light)',
            color: 'var(--color-fg-3)',
          },
          '&.cm-focused': { outline: 'none' },
          '.cm-content': { padding: '8px 0' },
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      debouncedOnChange.cancel();
      view.destroy();
      viewRef.current = null;
    };
    // Only initialize once. External value changes after mount are intentionally
    // ignored — the slideover remounts the editor per document + mode via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="h-full" data-testid="raw-md-editor" />;
}
