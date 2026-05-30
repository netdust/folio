import { describe, test, expect, vi } from 'vitest';
import { agentPanelBus } from './agent-panel-bus.ts';

describe('agentPanelBus', () => {
  test('open(tab) notifies subscribers with open + the tab', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.open('run');
    expect(fn).toHaveBeenCalledWith({ open: true, tab: 'run' });
    unsub();
  });
  test('open(activity) carries the activity tab', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.open('activity');
    expect(fn).toHaveBeenCalledWith({ open: true, tab: 'activity' });
    unsub();
  });
  test('close() notifies subscribers with open:false', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    agentPanelBus.close();
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ open: false }));
    unsub();
  });
  test('unsubscribe stops notifications', () => {
    const fn = vi.fn();
    const unsub = agentPanelBus.subscribe(fn);
    unsub();
    agentPanelBus.open('run');
    expect(fn).not.toHaveBeenCalled();
  });
});
