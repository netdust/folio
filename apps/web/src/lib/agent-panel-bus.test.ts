import { describe, test, expect, vi } from 'vitest';
import { agentPanelBus } from './agent-panel-bus.ts';

describe('agentPanelBus', () => {
  test('open(screen) notifies open:true + the screen', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.open('run');
    expect(fn).toHaveBeenCalledWith({ open: true, screen: 'run' });
    unsub();
  });
  test('toggle flips open', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.close();
    agentPanelBus.toggle();
    expect(fn).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
    agentPanelBus.toggle();
    expect(fn).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
    unsub();
  });
  test('unsubscribe stops notifications', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    unsub();
    agentPanelBus.open('activity');
    expect(fn).not.toHaveBeenCalled();
  });
});
