import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export type AiProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

export interface AiKey {
  id: string;
  workspaceId: string;
  provider: AiProvider;
  label: string;
  baseUrl: string | null;
  createdAt: string;
}

export const settingsKeys = {
  all: ['settings'] as const,
  aiKeys: (wslug: string, workspaceId: string) =>
    [...settingsKeys.all, 'ai-keys', wslug, workspaceId] as const,
};

export function useWorkspaceAiKeys(wslug: string, workspaceId: string) {
  return useQuery({
    queryKey: settingsKeys.aiKeys(wslug, workspaceId),
    queryFn: async () => {
      const wrapped = await client.get<{ keys: AiKey[] }>(
        `/api/v1/w/${wslug}/settings/${workspaceId}/ai-keys`,
      );
      return wrapped.keys;
    },
    staleTime: 60_000,
    enabled: !!wslug && !!workspaceId,
  });
}

export function useUpsertAiKey(wslug: string, workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      provider: AiProvider;
      apiKey: string;
      label?: string;
      baseUrl?: string;
    }) =>
      client.post<{ ok: true }>(
        `/api/v1/w/${wslug}/settings/${workspaceId}/ai-keys`,
        vars,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.aiKeys(wslug, workspaceId) }),
  });
}

export function useDeleteAiKey(wslug: string, workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      client.delete<{ ok: true }>(
        `/api/v1/w/${wslug}/settings/${workspaceId}/ai-keys/${keyId}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.aiKeys(wslug, workspaceId) }),
  });
}
