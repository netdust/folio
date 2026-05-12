import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export const authKeys = {
  me: ['auth', 'me'] as const,
};

export function useMe() {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: () => client.get<{ user: SessionUser }>('/api/v1/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
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
