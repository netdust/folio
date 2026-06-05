import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * The boot identity payload. `role` is the caller's instance role,
 * `is_instance_admin` the derived owner||admin signal, `ai_configured` whether
 * any instance AI key exists (one instance = one team). All are OPTIONAL because
 * the login/register responses seed the `me` cache with only `{ user }` — a
 * missing field must read as a safe default (`false` / undefined role), never
 * crash. `useIsInstanceAdmin()` / `useIsInstanceOwner()` enforce that default.
 * The fields refresh on the next `useMe` fetch after login/register.
 */
export interface MeResponse {
  user: SessionUser;
  // Server-authoritative INSTANCE role (users.role; one instance = one team).
  // OPTIONAL — login/register seed only `{ user }`; a missing flag reads as the
  // safe default.
  role?: 'owner' | 'admin' | 'member';
  // owner||admin signal. Mirrors the route's requireInstanceAdmin gate EXACTLY,
  // so the instance AI-key / admin UI shows only to users who can actually use
  // it. Missing → false.
  is_instance_admin?: boolean;
  // Presence-only: does ANY instance AI key exist? Readable by every user (no
  // admin gate, no key material), it drives the body editor's AI slash commands.
  // The key LIST is admin-gated; this is just "is an LLM reachable at all".
  ai_configured?: boolean;
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
 * Whether the current user is an instance admin (owner||admin) — the role that
 * may administer instance-level surfaces (AI keys, instance tokens, roles,
 * invitations). Mirrors the server's requireInstanceAdmin gate so the UI never
 * offers a control the route would 403. A stale/partial cache reads `false`.
 */
export function useIsInstanceAdmin(): boolean {
  return useMe().data?.is_instance_admin ?? false;
}

/**
 * Whether the current user is the instance OWNER — stricter than admin. Mirrors
 * the server's owner-only gates (e.g. PATCH /instance/users/:id/role). A
 * stale/partial cache reads `false`.
 */
export function useIsInstanceOwner(): boolean {
  return useMe().data?.role === 'owner';
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      client.post<{ user: SessionUser }>('/api/v1/auth/login', vars),
    onSuccess: (data) => {
      // Seed an instant optimistic user for the rest of the app, then
      // invalidate so the full `me` payload (incl. role / is_instance_admin /
      // ai_configured) self-populates — otherwise those flags stay undefined for
      // up to staleTime (60s) and admin surfaces hide.
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
      // See useLogin: seed optimistic user, then invalidate so the full payload
      // (incl. role / is_instance_admin / ai_configured) refetches instead of
      // waiting out staleTime.
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
