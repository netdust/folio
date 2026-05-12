import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { clipboard } from '@milkdown/plugin-clipboard';
import { useEffect, useRef } from 'react';
import { debounce } from '../../lib/debounce.ts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}

function MilkdownEditor({ value, onChange, readOnly }: Props) {
  const valueRef = useRef(value);
  valueRef.current = value;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const debouncedOnChange = useRef(debounce((md: string) => onChangeRef.current(md), 400)).current;

  useEffect(() => () => debouncedOnChange.cancel(), [debouncedOnChange]);

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

  return <Milkdown />;
}

export function BodyEditor(props: Props) {
  return (
    <MilkdownProvider>
      <div className="folio-milkdown">
        <MilkdownEditor {...props} />
      </div>
    </MilkdownProvider>
  );
}
