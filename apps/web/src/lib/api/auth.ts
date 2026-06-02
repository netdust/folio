import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * D2: the boot identity payload. `is_system_member` is server-authoritative
 * (computed from `__system` membership) and OPTIONAL on the type because the
 * login/register responses seed the `me` cache with only `{ user }` — a missing
 * flag must read as `false`, never crash. `useIsSystemMember()` enforces that
 * default. The flag refreshes on the next `useMe` fetch after login/register.
 */
export interface MeResponse {
  user: SessionUser;
  is_system_member?: boolean;
}

export const authKeys = {
  me: ['auth', 'me'] as const,
};

export function useMe() {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: () => client.get<MeResponse>('/api/v1/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Whether the current user is a member of the `__system` library workspace.
 * Reads the server-authoritative flag off the cached `/me` payload; a stale or
 * partial cache (e.g. the post-login `{ user }`-only seed) reads `false`.
 */
export function useIsSystemMember(): boolean {
  return useMe().data?.is_system_member ?? false;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      client.post<{ user: SessionUser }>('/api/v1/auth/login', vars),
    onSuccess: (data) => qc.setQueryData(authKeys.me, data),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; password: string; name: string }) =>
      client.post<{ user: SessionUser }>('/api/v1/auth/register', vars),
    onSuccess: (data) => qc.setQueryData(authKeys.me, data),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.post<{ ok: true }>('/api/v1/auth/logout'),
    onSuccess: () => {
      qc.setQueryData(authKeys.me, null);
      qc.clear();
    },
  });
}

export function useMagicLinkRequest() {
  return useMutation({
    mutationFn: (vars: { email: string }) =>
      client.post<{ ok: true }>('/api/v1/auth/magic-link/request', vars),
  });
}
