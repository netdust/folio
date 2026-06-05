import { useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { cn } from '../ui/cn.ts';

/**
 * The cockpit chat composer: a growing textarea that submits on Enter (Shift+
 * Enter = newline). While `busy` (a run is active on the conversation) it is
 * disabled and shows an "operator is working…" hint — the single-active-turn
 * model (M14) is enforced server-side too, but blocking the field here avoids a
 * pointless 409 round-trip. Presentational: the parent owns the conversation and
 * decides what `onSubmit` does (create-then-post, or post).
 */
export function ChatComposer({
  onSubmit,
  busy,
}: {
  onSubmit: (text: string) => void | Promise<void>;
  busy: boolean;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (busy) return;
    const text = value.trim();
    if (!text) return;
    // Optimistically clear; if onSubmit rejects (post/create failed), RESTORE the
    // text so it isn't silently lost (review #3/#7).
    setValue('');
    void Promise.resolve()
      .then(() => onSubmit(text))
      .catch(() => setValue((cur) => (cur.length === 0 ? text : cur)));
  };

  return (
    <div className="border-t border-border-light p-2">
      {busy ? (
        <p className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-fg-3">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
          operator is working…
        </p>
      ) : null}
      <div
        className={cn(
          'flex items-end gap-2 rounded-lg border border-border-light bg-card px-2.5 py-1.5',
          busy && 'opacity-60',
        )}
      >
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={busy}
          placeholder="Ask the operator…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Ignore Enter while an IME composition is active — pressing Enter to
            // CONFIRM a CJK/accent candidate must not submit (review #6).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          aria-label="Send"
          disabled={busy || value.trim().length === 0}
          onClick={submit}
          className="shrink-0 rounded-md bg-primary p-1 text-primary-fg transition-opacity duration-fast disabled:opacity-40"
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
