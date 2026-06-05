import { useMutation, useQueryClient } from '@tanstack/react-query';
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

export const instanceAccessKeys = {
  all: ['instance-access'] as const,
};

const BASE = '/api/v1/instance/access';

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
