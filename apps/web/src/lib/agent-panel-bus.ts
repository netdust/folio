export type AgentPanelScreen = 'activity' | 'run' | 'agents';
export interface AgentPanelState {
  open: boolean;
  screen: AgentPanelScreen;
}
type Listener = (s: AgentPanelState) => void;
const listeners = new Set<Listener>();
let state: AgentPanelState = { open: false, screen: 'activity' };
function emit() {
  for (const l of listeners) l(state);
}
export const agentPanelBus = {
  open(screen: AgentPanelScreen = 'activity') {
    state = { open: true, screen };
    emit();
  },
  close() {
    state = { ...state, open: false };
    emit();
  },
  toggle() {
    state = { ...state, open: !state.open };
    emit();
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
