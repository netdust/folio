import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ApiTokenCreateResponse {
  id: string;
  name: string;
  token: string;
  scopes: string[];
}

export interface TokenCreate {
  name: string;
  scopes: string[];
  // Optional expiry: number of days from now after which the bearer middleware
  // rejects the token. Omitted entirely = never expires (the server treats a
  // missing key as a null expiresAt).
  expires_in_days?: number;
  // Reach is no longer chosen here — the per-workspace POST always pins to the
  // URL workspace; instance (reach=null) tokens are minted via the dedicated
  // /instance/tokens surface.
}

export const tokensKeys = {
  list: (wslug: string, workspaceId: string) => ['tokens', wslug, workspaceId] as const,
};

export function useTokens(wslug: string, workspaceId: string) {
  return useQuery({
    queryKey: tokensKeys.list(wslug, workspaceId),
    queryFn: async () => {
      const wrapped = await client.get<{ tokens: ApiToken[] }>(
        `/api/v1/w/${wslug}/tokens/${workspaceId}`,
      );
      return wrapped.tokens;
    },
    enabled: !!wslug && !!workspaceId,
  });
}

export function useCreateToken(wslug: string, workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TokenCreate) =>
      client.post<ApiTokenCreateResponse>(
        `/api/v1/w/${wslug}/tokens/${workspaceId}`,
        payload,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensKeys.list(wslug, workspaceId) }),
  });
}

export function useDeleteToken(wslug: string, workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      client.delete<{ ok: boolean }>(
        `/api/v1/w/${wslug}/tokens/${workspaceId}/${tokenId}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: tokensKeys.list(wslug, workspaceId) }),
  });
}

// --- Instance (reach=null) tokens ---------------------------------------------
// Cross-workspace tokens for operator/admin automation (create workspaces,
// change settings). Session-only + instance-admin on the server. These live on
// the instance Settings page, NOT inside a workspace — minting one never
// requires picking a workspace.

export const instanceTokensKeys = { list: ['instance-tokens'] as const };

export function useInstanceTokens() {
  return useQuery({
    queryKey: instanceTokensKeys.list,
    queryFn: async () => {
      const wrapped = await client.get<{ tokens: ApiToken[] }>('/api/v1/instance/tokens');
      return wrapped.tokens;
    },
  });
}

export function useCreateInstanceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; scopes: string[]; expires_in_days?: number }) =>
      client.post<ApiTokenCreateResponse>('/api/v1/instance/tokens', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceTokensKeys.list }),
  });
}

export function useDeleteInstanceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      client.delete<{ ok: boolean }>(`/api/v1/instance/tokens/${tokenId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceTokensKeys.list }),
  });
}
