import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorModelSetting } from '@folio/shared';
import { client } from './client.ts';
import type { AiProvider } from './settings.ts';

export type { AiProvider, OperatorModelSetting };

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

/** The GET /instance/ai-keys payload: the key roster + the current operator-model
 *  selection (which configured provider+model the operator runs on). */
interface InstanceAiKeysPayload {
  keys: InstanceAiKey[];
  operator_model: OperatorModelSetting | null;
}

/** Shared query options — ONE fetch backs both the keys list and the operator
 *  model (each hook projects its slice via `select`, so no double fetch). */
function aiKeysQueryOptions(enabled: boolean) {
  return {
    queryKey: instanceAiKeysKeys.list(),
    queryFn: () => client.get<InstanceAiKeysPayload>(BASE),
    staleTime: 60_000,
    enabled,
  };
}

/** List instance AI keys (metadata only — the server never returns the secret).
 *  Gated server-side on instance owner/admin; pass `enabled` to skip the fetch for
 *  non-admins. */
export function useInstanceAiKeys(opts: { enabled?: boolean } = {}) {
  return useQuery({
    ...aiKeysQueryOptions(opts.enabled ?? true),
    select: (r: InstanceAiKeysPayload) => r.keys,
  });
}

/** The current operator-model selection ({provider, model, aiKeyLabel} or null),
 *  projected from the same GET as the keys list (no extra fetch). */
export function useOperatorModel(opts: { enabled?: boolean } = {}) {
  return useQuery({
    ...aiKeysQueryOptions(opts.enabled ?? true),
    select: (r: InstanceAiKeysPayload) => r.operator_model,
  });
}

/** Set which configured provider+model the operator runs on (admin-gated route).
 *  The {provider, aiKeyLabel} must reference an existing key (server 422 if not). */
export function useSetOperatorModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: OperatorModelSetting) =>
      client.put<{ ok: true; operator_model: OperatorModelSetting }>(
        `${BASE}/operator-model`,
        vars,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceAiKeysKeys.all }),
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
