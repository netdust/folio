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
  aiKeys: (workspaceId: string) => [...settingsKeys.all, 'ai-keys', workspaceId] as const,
};

export function useWorkspaceAiKeys(workspaceId: string) {
  return useQuery({
    queryKey: settingsKeys.aiKeys(workspaceId),
    queryFn: () =>
      client.get<{ keys: AiKey[] }>(`/api/v1/settings/${workspaceId}/ai-keys`),
    staleTime: 60_000,
    enabled: !!workspaceId,
  });
}

export function useUpsertAiKey(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      provider: AiProvider;
      apiKey: string;
      label?: string;
      baseUrl?: string;
    }) =>
      client.post<{ ok: true }>(
        `/api/v1/settings/${workspaceId}/ai-keys`,
        vars,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.aiKeys(workspaceId) }),
  });
}

export function useDeleteAiKey(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      client.delete<{ ok: true }>(`/api/v1/settings/${workspaceId}/ai-keys/${keyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.aiKeys(workspaceId) }),
  });
}
