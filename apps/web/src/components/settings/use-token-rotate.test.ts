import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ApiToken } from '../../lib/api/tokens.ts';
import { useTokenRotate } from './use-token-rotate.ts';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

function makeToken(over: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 'tok_old',
    name: 'CI',
    scopes: ['documents:read'],
    createdAt: '2026-05-25T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    ...over,
  };
}

beforeEach(() => {
  toastError.mockClear();
});

describe('useTokenRotate.confirmRotate', () => {
  it('mints the new token BEFORE revoking the old one (create then delete)', async () => {
    const calls: string[] = [];
    const createToken = {
      mutateAsync: vi.fn(async () => {
        calls.push('create');
        return { token: 'folio_pat_rotated' };
      }),
    };
    const deleteToken = {
      mutateAsync: vi.fn(async (id: string) => {
        calls.push(`delete:${id}`);
      }),
    };

    const { result } = renderHook(() => useTokenRotate({ createToken, deleteToken }));
    act(() => result.current.setPendingRotate(makeToken()));
    await act(async () => {
      await result.current.confirmRotate();
    });

    // Ordering is the safety invariant: never revoke before the new secret exists.
    expect(calls).toEqual(['create', 'delete:tok_old']);
    expect(result.current.rotatedSecret).toBe('folio_pat_rotated');
    expect(result.current.pendingRotate).toBeNull();
    expect(result.current.rotating).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does NOT revoke the old token when minting fails, and reports rotation failed', async () => {
    const createToken = {
      mutateAsync: vi.fn(async () => {
        throw new Error('mint blew up');
      }),
    };
    const deleteToken = { mutateAsync: vi.fn(async () => undefined) };

    const { result } = renderHook(() => useTokenRotate({ createToken, deleteToken }));
    act(() => result.current.setPendingRotate(makeToken()));
    await act(async () => {
      await result.current.confirmRotate();
    });

    // Mint failed → the old token must stay valid → no delete fired.
    expect(deleteToken.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.rotatedSecret).toBeNull();
    expect(result.current.pendingRotate).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toMatch(/your existing token is unchanged/i);
  });

  it('reports a manual-revoke warning when the old token delete fails after a successful mint', async () => {
    const createToken = { mutateAsync: vi.fn(async () => ({ token: 'folio_pat_rotated' })) };
    const deleteToken = {
      mutateAsync: vi.fn(async () => {
        throw new Error('revoke blew up');
      }),
    };

    const { result } = renderHook(() => useTokenRotate({ createToken, deleteToken }));
    act(() => result.current.setPendingRotate(makeToken()));
    await act(async () => {
      await result.current.confirmRotate();
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toMatch(/could not be revoked — revoke "CI" manually/i);
  });

  it('carries the original expiry forward as a positive-integer expires_in_days', async () => {
    const createToken = { mutateAsync: vi.fn(async () => ({ token: 'folio_pat_rotated' })) };
    const deleteToken = { mutateAsync: vi.fn(async () => undefined) };
    const tenDaysOut = new Date(Date.now() + 10 * 86_400_000).toISOString();

    const { result } = renderHook(() => useTokenRotate({ createToken, deleteToken }));
    act(() => result.current.setPendingRotate(makeToken({ expiresAt: tenDaysOut })));
    await act(async () => {
      await result.current.confirmRotate();
    });

    const vars = createToken.mutateAsync.mock.calls[0][0] as { expires_in_days?: number };
    expect(Number.isInteger(vars.expires_in_days)).toBe(true);
    expect(vars.expires_in_days).toBeGreaterThanOrEqual(9);
    expect(vars.expires_in_days).toBeLessThanOrEqual(11);
  });

  it('omits expires_in_days for a forever (null expiresAt) token', async () => {
    const createToken = { mutateAsync: vi.fn(async () => ({ token: 'folio_pat_rotated' })) };
    const deleteToken = { mutateAsync: vi.fn(async () => undefined) };

    const { result } = renderHook(() => useTokenRotate({ createToken, deleteToken }));
    act(() => result.current.setPendingRotate(makeToken({ expiresAt: null })));
    await act(async () => {
      await result.current.confirmRotate();
    });

    const vars = createToken.mutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(vars).not.toHaveProperty('expires_in_days');
  });
});
