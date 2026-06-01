import { useRef, useState } from 'react';

export interface UnsavedGuard {
  /** If dirty, defer `action` and start prompting; otherwise run it now. */
  guard: (action: () => void) => void;
  /** True while the confirm dialog should be shown. */
  prompting: boolean;
  /** Run the queued action (e.g. after Save or Discard) and stop prompting. */
  proceed: () => void;
  /** Drop the queued action and stop prompting. */
  cancel: () => void;
}

/**
 * Intercepts a navigation/close action when there are unsaved edits. The caller
 * renders its own confirm dialog driven by `prompting`, wiring Save/Discard to
 * `proceed` (after persisting/discarding) and Cancel to `cancel`.
 */
export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const [prompting, setPrompting] = useState(false);
  const queued = useRef<(() => void) | null>(null);

  const guard = (action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    queued.current = action;
    setPrompting(true);
  };

  const proceed = () => {
    const action = queued.current;
    queued.current = null;
    setPrompting(false);
    action?.();
  };

  const cancel = () => {
    queued.current = null;
    setPrompting(false);
  };

  return { guard, prompting, proceed, cancel };
}
