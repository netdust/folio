import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';
import { documentsKeys } from './documents.ts';
import { tablesKeys } from './tables.ts';

export interface Project {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  icon: string | null;
  description: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const projectsKeys = {
  all: ['projects'] as const,
  list: (wslug: string) => [...projectsKeys.all, wslug, 'list'] as const,
  detail: (wslug: string, pslug: string) => [...projectsKeys.all, wslug, 'detail', pslug] as const,
};

export function useProjects(wslug: string) {
  return useQuery({
    queryKey: projectsKeys.list(wslug),
    queryFn: () => client.get<Project[]>(`/api/v1/w/${wslug}/projects`),
    staleTime: 30_000,
    enabled: !!wslug,
  });
}

export function useProject(wslug: string, pslug: string) {
  return useQuery({
    queryKey: projectsKeys.detail(wslug, pslug),
    queryFn: () => client.get<Project>(`/api/v1/w/${wslug}/p/${pslug}`),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug,
  });
}

export function useCreateProject(wslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; slug: string; icon?: string | null }) =>
      client.post<Project>(`/api/v1/w/${wslug}/projects`, vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectsKeys.list(wslug) }),
  });
}

export interface ProjectPatch {
  name?: string;
  icon?: string | null;
  description?: string | null;
}

export function useUpdateProject(wslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pslug, patch }: { pslug: string; patch: ProjectPatch }) =>
      client.patch<Project>(`/api/v1/w/${wslug}/p/${pslug}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectsKeys.list(wslug) }),
  });
}

export function useDeleteProject(wslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pslug: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}`),
    onSuccess: (_data, pslug) => {
      // Cascade-invalidate everything that was scoped to this project.
      // Without this, useQueries in the workspace layout keeps serving stale
      // tables/views for the deleted project until staleTime expires.
      qc.invalidateQueries({ queryKey: projectsKeys.list(wslug) });
      qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, pslug) });
      // Views + documents are now TABLE-scoped (keys carry a tslug segment).
      // A project delete must bust them across ALL of the project's tables, so
      // target the project-wide prefix (drop the tslug + any 'list' literal):
      //   views:     ['views', w, p]          ⊂ ['views', w, p, <tslug>]
      //   documents: ['documents', w, p]      ⊂ [...all, w, p, <tslug>, 'list', <params>]
      // The pre-Cluster-1 keys (viewsKeys.list 2-arg, documents [...,'list'])
      // no longer match the table-scoped read keys.
      qc.invalidateQueries({ queryKey: ['views', wslug, pslug] });
      qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug] });
    },
  });
}
