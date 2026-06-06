import { describe, test, expect, vi, beforeEach } from 'vitest';

// Each test re-imports the module fresh so the default-open-from-storage logic
// is re-evaluated against the mocked localStorage state.
async function freshBus() {
  vi.resetModules();
  return (await import('./agent-panel-bus.ts')).agentPanelBus;
}

beforeEach(() => {
  globalThis.localStorage?.clear?.();
});

describe('agentPanelBus', () => {
  test('defaults to OPEN when the user has never closed it', async () => {
    const bus = await freshBus();
    expect(bus.get().open).toBe(true);
  });

  test('respects last-closed: a persisted closed bit means it starts CLOSED', async () => {
    globalThis.localStorage.setItem('folio:cockpit-closed', '1');
    const bus = await freshBus();
    expect(bus.get().open).toBe(false);
  });

  test('close() persists the closed bit (so a reload stays closed)', async () => {
    const bus = await freshBus();
    bus.close();
    expect(globalThis.localStorage.getItem('folio:cockpit-closed')).toBe('1');
    // A fresh load now starts closed.
    const reloaded = await freshBus();
    expect(reloaded.get().open).toBe(false);
  });

  test('open() clears the closed bit (so a reload stays open)', async () => {
    globalThis.localStorage.setItem('folio:cockpit-closed', '1');
    const bus = await freshBus();
    expect(bus.get().open).toBe(false);
    bus.open();
    expect(globalThis.localStorage.getItem('folio:cockpit-closed')).toBeNull();
    expect(bus.get().open).toBe(true);
  });

  test('toggle flips open and persists each way', async () => {
    const bus = await freshBus();
    const fn = vi.fn();
    const unsub = bus.subscribe(fn);
    bus.close();
    expect(fn).toHaveBeenLastCalledWith({ open: false });
    bus.toggle();
    expect(fn).toHaveBeenLastCalledWith({ open: true });
    expect(globalThis.localStorage.getItem('folio:cockpit-closed')).toBeNull();
    unsub();
  });

  test('no more screen field — the state is open-only', async () => {
    const bus = await freshBus();
    expect(bus.get()).toEqual({ open: true });
  });

  test('unsubscribe stops notifications', async () => {
    const bus = await freshBus();
    const fn = vi.fn();
    const unsub = bus.subscribe(fn);
    unsub();
    bus.toggle();
    expect(fn).not.toHaveBeenCalled();
  });
});
