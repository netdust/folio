import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembership {
  workspace: Workspace;
  role: WorkspaceRole;
}

export interface WorkspaceDetail extends Workspace {
  role: WorkspaceRole;
  claude_code_enabled?: boolean;
}

export const workspacesKeys = {
  all: ['workspaces'] as const,
  list: () => [...workspacesKeys.all, 'list'] as const,
  detail: (wslug: string) => [...workspacesKeys.all, 'detail', wslug] as const,
};

export function useWorkspaces() {
  return useQuery({
    queryKey: workspacesKeys.list(),
    queryFn: () => client.get<WorkspaceMembership[]>('/api/v1/workspaces'),
    staleTime: 30_000,
  });
}

export function useWorkspace(wslug: string) {
  return useQuery({
    queryKey: workspacesKeys.detail(wslug),
    queryFn: () => client.get<WorkspaceDetail>(`/api/v1/w/${wslug}`),
    staleTime: 30_000,
    enabled: !!wslug,
  });
}

export type CreatedWorkspace = Pick<Workspace, 'id' | 'slug' | 'name'>;

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; slug?: string }) =>
      client.post<CreatedWorkspace>('/api/v1/workspaces', vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKeys.list() }),
  });
}
