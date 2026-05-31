export interface BoardSort {
  key: string;
  dir: 'asc' | 'desc';
}
// `sort: null` = manual; the `sort` key absent = not overridden.
export interface BoardOverride {
  groupBy?: string;
  sort?: BoardSort | null;
}

const overrides = new Map<string, BoardOverride>();
type Listener = () => void;
const listeners = new Set<Listener>();
function emit() {
  for (const l of listeners) l();
}

export const boardControlsBus = {
  get(viewId: string): BoardOverride | undefined {
    return overrides.get(viewId);
  },
  setGroupBy(viewId: string, groupBy: string) {
    overrides.set(viewId, { ...overrides.get(viewId), groupBy });
    emit();
  },
  setSort(viewId: string, sort: BoardSort | null) {
    overrides.set(viewId, { ...overrides.get(viewId), sort });
    emit();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  reset() {
    overrides.clear();
    emit();
  },
};
