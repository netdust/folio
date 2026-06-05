// The cockpit panel's open/closed bus (T12).
//
// The cockpit is now the operator CHAT — a single surface, no Activity/Run tabs
// (those screens are deleted in T14). So the state collapses to `{ open }`; the
// old `screen: 'activity' | 'run'` is gone.
//
// DEFAULT-OPEN with respect-last-closed: the panel opens by default on every
// load, EXCEPT once the user has explicitly closed it — that choice persists in
// localStorage (`folio:cockpit-closed`). Opening again clears the bit. "Close =
// human-only mode": the user opts out of the operator surface and it stays out
// until they reopen it. Guarded for environments without localStorage (tests via
// resetModules, SSR) — accessors no-op there.

import { getStoredItem, removeStoredItem, setStoredItem } from './safe-storage.ts';

const STORAGE_KEY = 'folio:cockpit-closed';

export interface AgentPanelState {
  open: boolean;
}

function persistedClosed(): boolean {
  return getStoredItem(STORAGE_KEY) === '1';
}

type Listener = (s: AgentPanelState) => void;
const listeners = new Set<Listener>();

// Default-open unless the user previously closed it.
let state: AgentPanelState = { open: !persistedClosed() };

function emit() {
  for (const l of listeners) l(state);
}

export const agentPanelBus = {
  open() {
    removeStoredItem(STORAGE_KEY);
    state = { open: true };
    emit();
  },
  close() {
    setStoredItem(STORAGE_KEY, '1');
    state = { open: false };
    emit();
  },
  toggle() {
    if (state.open) this.close();
    else this.open();
  },
  get() {
    return state;
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
