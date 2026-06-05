import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

/** A user in the instance roster (Roles section). Never carries password_hash. */
export interface InstanceUser {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

/** Invite-target enumeration: every workspace + project a grant can point at. */
export interface InviteTargets {
  workspaces: { id: string; slug: string; name: string }[];
  projects: { id: string; slug: string; name: string; workspaceId: string }[];
}

export const instanceUsersKeys = {
  all: ['instance-users'] as const,
  list: () => [...instanceUsersKeys.all, 'list'] as const,
  inviteTargets: () => ['instance-invite-targets'] as const,
};

/** GET /instance/users — the roster + roles. Owner+admin (server-gated). */
export function useInstanceUsers(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: instanceUsersKeys.list(),
    queryFn: async () => {
      const wrapped = await client.get<{ users: InstanceUser[] }>('/api/v1/instance/users');
      return wrapped.users;
    },
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

/** GET /instance/invite-targets — workspaces + projects to grant into. Owner+admin. */
export function useInviteTargets(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: instanceUsersKeys.inviteTargets(),
    queryFn: () => client.get<InviteTargets>('/api/v1/instance/invite-targets'),
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

/**
 * POST /instance/invites — invite a NEW person by email (owner+admin). Sends a
 * magic link; the user is created (as a member) when they click it. Distinct from
 * granting access (useGrantAccess), which targets an already-existing user.
 */
export function useInviteByEmail() {
  return useMutation({
    mutationFn: (vars: { email: string }) =>
      client.post<{ ok: boolean }>('/api/v1/instance/invites', vars),
  });
}

/** PATCH /instance/users/:id/role — OWNER-only instance role change. */
export function useSetUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userId: string; role: 'owner' | 'admin' | 'member' }) =>
      client.patch<{ id: string; role: string }>(
        `/api/v1/instance/users/${vars.userId}/role`,
        { role: vars.role },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceUsersKeys.all }),
  });
}
