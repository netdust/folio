import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUnsavedGuard } from './use-unsaved-guard.ts';

describe('useUnsavedGuard', () => {
  it('runs the action immediately when not dirty', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: false },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.prompting).toBe(false);
  });

  it('defers the action and prompts when dirty', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: true },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.prompting).toBe(true);
  });

  it('proceed() runs the queued action and stops prompting', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: true },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    act(() => result.current.proceed());
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.prompting).toBe(false);
  });

  it('cancel() drops the queued action without running it', () => {
    const { result } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: true },
    });
    const action = vi.fn();
    act(() => result.current.guard(action));
    act(() => result.current.cancel());
    expect(action).not.toHaveBeenCalled();
    expect(result.current.prompting).toBe(false);
  });
});
