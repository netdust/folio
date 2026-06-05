import { useState } from 'react';
import { toast } from 'sonner';
import {
  useDeleteUser,
  useInstanceUsers,
  useSetUserRole,
  type InstanceUser,
} from '../../lib/api/instance-users.ts';
import { useIsInstanceOwner, useMe } from '../../lib/api/auth.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Button } from '../ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';

const ROLES = ['owner', 'admin', 'member'] as const;

/**
 * Instance Roles section. Lists every user + their instance role. The role
 * SELECT is owner-only (mirrors the server's OWNER-only PATCH gate — the UI
 * never offers a control the route would 403); admins see the roles read-only.
 * The server is the authority; this is the affordance.
 */
export function RolesTab() {
  const isOwner = useIsInstanceOwner();
  const myId = useMe().data?.user?.id;
  const usersQuery = useInstanceUsers();
  const setRole = useSetUserRole();
  const deleteUser = useDeleteUser();
  const [pendingRemove, setPendingRemove] = useState<InstanceUser | null>(null);

  if (usersQuery.isLoading) {
    return <p className="text-xs text-fg-3">Loading users…</p>;
  }
  if (usersQuery.isError) {
    return <p className="text-xs text-danger">Couldn't load users.</p>;
  }
  const users = usersQuery.data ?? [];

  async function onChangeRole(userId: string, role: (typeof ROLES)[number]) {
    try {
      await setRole.mutateAsync({ userId, role });
      toast.success('Role updated');
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onConfirmRemove() {
    if (!pendingRemove) return;
    try {
      await deleteUser.mutateAsync(pendingRemove.id);
      toast.success(`Removed ${pendingRemove.email}`);
      setPendingRemove(null);
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border-light rounded-md border border-border-light">
        {users.map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm">{u.name}</div>
              <div className="truncate text-xs text-fg-3">{u.email}</div>
            </div>
            {isOwner && u.id !== myId ? (
              <div className="flex items-center gap-2">
                <select
                  className="rounded border border-border-light bg-shell px-2 py-1 text-xs"
                  value={u.role}
                  disabled={setRole.isPending}
                  onChange={(e) => onChangeRole(u.id, e.target.value as (typeof ROLES)[number])}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                {/* Offboard: hard-deletes the account + revokes their sessions,
                    grants, and minted tokens. Owner-only; never on your own row
                    (the server refuses self-delete too). */}
                <button
                  type="button"
                  className="text-xs text-fg-3 hover:text-danger"
                  disabled={deleteUser.isPending}
                  onClick={() => setPendingRemove(u)}
                >
                  Remove
                </button>
              </div>
            ) : (
              // Your own row is read-only: an owner can't strip their own role
              // (the server refuses self-demotion too). Non-owners see all roles
              // read-only.
              <span className="text-xs text-fg-2">{u.role}</span>
            )}
          </li>
        ))}
      </ul>
      {!isOwner ? (
        <p className="text-[11px] text-fg-3">Only the instance owner can change roles.</p>
      ) : null}

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Remove {pendingRemove?.email}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the account and revokes their sessions, API
            tokens, and workspace/project access. Documents they authored are kept.
            This cannot be undone.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingRemove(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={onConfirmRemove} loading={deleteUser.isPending}>
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
