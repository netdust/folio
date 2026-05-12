import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  aiProvider: string | null;
  aiModel: string | null;
  keyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export const workspacesKeys = {
  all: ['workspaces'] as const,
  list: () => [...workspacesKeys.all, 'list'] as const,
  detail: (wslug: string) => [...workspacesKeys.all, 'detail', wslug] as const,
};

export function useWorkspaces() {
  return useQuery({
    queryKey: workspacesKeys.list(),
    queryFn: () => client.get<Workspace[]>('/api/v1/workspaces'),
    staleTime: 30_000,
  });
}

export function useWorkspace(wslug: string) {
  return useQuery({
    queryKey: workspacesKeys.detail(wslug),
    queryFn: () => client.get<Workspace>(`/api/v1/w/${wslug}`),
    staleTime: 30_000,
    enabled: !!wslug,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; slug: string; aiProvider?: string | null }) =>
      client.post<Workspace>('/api/v1/workspaces', vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKeys.list() }),
  });
}
