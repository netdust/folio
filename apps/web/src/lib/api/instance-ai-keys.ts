import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';
import type { AiProvider } from './settings.ts';

export type { AiProvider };

/** Instance-level AI key (workspace-independent). Identified by (provider, label).
 *  No workspaceId — these are one store for the whole instance. */
export interface InstanceAiKey {
  id: string;
  provider: AiProvider;
  label: string;
  baseUrl: string | null;
  createdAt: string;
}

export const instanceAiKeysKeys = {
  all: ['instance-ai-keys'] as const,
  list: () => [...instanceAiKeysKeys.all, 'list'] as const,
};

const BASE = '/api/v1/instance/ai-keys';

/** List instance AI keys (metadata only — the server never returns the secret).
 *  Gated server-side on __system owner/admin; pass `enabled` to skip the fetch for
 *  non-admins. */
export function useInstanceAiKeys(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: instanceAiKeysKeys.list(),
    queryFn: async () => {
      const wrapped = await client.get<{ keys: InstanceAiKey[] }>(BASE);
      return wrapped.keys;
    },
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

export function useUpsertInstanceAiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      provider: AiProvider;
      apiKey: string;
      label?: string;
      baseUrl?: string;
    }) =>
      client.post<{
        id: string;
        provider: AiProvider;
        label: string;
        paid_residual_live: boolean;
      }>(BASE, vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceAiKeysKeys.all }),
  });
}

export function useDeleteInstanceAiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => client.delete<{ ok: true }>(`${BASE}/${keyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceAiKeysKeys.all }),
  });
}
