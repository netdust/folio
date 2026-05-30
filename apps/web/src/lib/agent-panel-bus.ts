export type AgentPanelTab = 'run' | 'activity';

export interface AgentPanelState {
  open: boolean;
  tab: AgentPanelTab;
}

type Listener = (s: AgentPanelState) => void;

const listeners = new Set<Listener>();
let state: AgentPanelState = { open: false, tab: 'run' };

export const agentPanelBus = {
  open(tab: AgentPanelTab = 'run') {
    state = { open: true, tab };
    listeners.forEach((l) => l(state));
  },
  close() {
    state = { ...state, open: false };
    listeners.forEach((l) => l(state));
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
