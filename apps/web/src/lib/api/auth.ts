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
  // Server-authoritative owner/admin-of-__system signal. OPTIONAL for the same
  // reason as is_system_member (login/register seed only `{ user }`); a missing
  // flag reads false. Mirrors the route's requireInstanceAdmin gate EXACTLY, so
  // the instance AI-key UI shows only to users who can actually write keys.
  is_instance_admin?: boolean;
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

/**
 * Whether the current user is an owner/admin of `__system` — the role that may
 * administer instance-level surfaces (AI keys, instance tokens). Mirrors the
 * server's requireInstanceAdmin gate so the UI never offers a control the route
 * would 403. A stale/partial cache reads `false`.
 */
export function useIsInstanceAdmin(): boolean {
  return useMe().data?.is_instance_admin ?? false;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      client.post<{ user: SessionUser }>('/api/v1/auth/login', vars),
    onSuccess: (data) => {
      // Seed an instant optimistic user for the rest of the app, then
      // invalidate so the full `me` payload (incl. server-authoritative
      // `is_system_member`) self-populates — otherwise the flag stays
      // undefined for up to staleTime (60s) and the System Library entry hides.
      qc.setQueryData(authKeys.me, data);
      qc.invalidateQueries({ queryKey: authKeys.me });
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; password: string; name: string }) =>
      client.post<{ user: SessionUser }>('/api/v1/auth/register', vars),
    onSuccess: (data) => {
      // See useLogin: seed optimistic user, then invalidate so the full
      // payload (incl. `is_system_member`) refetches instead of waiting out
      // staleTime.
      qc.setQueryData(authKeys.me, data);
      qc.invalidateQueries({ queryKey: authKeys.me });
    },
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
