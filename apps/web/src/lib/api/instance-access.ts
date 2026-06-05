import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';
import { instanceUsersKeys } from './instance-users.ts';

/**
 * Instance access grants — invitation-based workspace/project visibility
 * (replaces the dropped `memberships`). The server exposes grant (POST) +
 * revoke (DELETE) only; there is no list-grants endpoint (the Invitations UI
 * grants/revokes against the invite-targets enumeration, it does not render an
 * existing-grants roster). Exactly ONE of workspaceId | projectId per grant.
 */

export interface AccessGrantVars {
  userId: string;
  workspaceId?: string;
  projectId?: string;
}

/** A row in the grant roster (GET /instance/access). */
export type AccessGrant =
  | {
      kind: 'workspace';
      userId: string;
      userEmail: string;
      userName: string;
      workspaceId: string;
      workspaceSlug: string;
      workspaceName: string;
    }
  | {
      kind: 'project';
      userId: string;
      userEmail: string;
      userName: string;
      projectId: string;
      projectSlug: string;
      projectName: string;
      workspaceId: string;
    };

export const instanceAccessKeys = {
  all: ['instance-access'] as const,
  list: () => [...instanceAccessKeys.all, 'list'] as const,
};

const BASE = '/api/v1/instance/access';

/** GET /instance/access — the grant roster. Owner+admin (server-gated). */
export function useInstanceAccess(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: instanceAccessKeys.list(),
    queryFn: async () => {
      const wrapped = await client.get<{ grants: AccessGrant[] }>(BASE);
      return wrapped.grants;
    },
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

/** POST /instance/access — grant a user access to a workspace or project. */
export function useGrantAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: AccessGrantVars) => client.post<{ ok: true }>(BASE, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: instanceAccessKeys.all });
      // A grant can change who appears in workspace member contexts.
      qc.invalidateQueries({ queryKey: instanceUsersKeys.all });
    },
  });
}

/** DELETE /instance/access — revoke a user's workspace/project grant. */
export function useRevokeAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: AccessGrantVars) =>
      client.deleteWithBody<{ ok: true }>(BASE, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: instanceAccessKeys.all });
      qc.invalidateQueries({ queryKey: instanceUsersKeys.all });
    },
  });
}
