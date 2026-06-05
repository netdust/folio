import { useState } from 'react';
import { toast } from 'sonner';
import {
  type AccessGrantVars,
  useGrantAccess,
  useInstanceAccess,
  useRevokeAccess,
} from '../../lib/api/instance-access.ts';
import {
  useInstanceUsers,
  useInviteTargets,
  useInviteByEmail,
} from '../../lib/api/instance-users.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { Button } from '../ui/button.tsx';

/**
 * Instance Invitations section. Owner+admin grant a user access to a workspace
 * or project (the post-`memberships` model — access is an explicit grant), and
 * revoke. The target options come from the invite-targets enumeration; the
 * current grants come from the roster (GET /instance/access). Server enforces
 * the admin gate; this is the affordance.
 *
 * One <select> covers both workspaces and projects: each option's value encodes
 * its kind via `encodeTarget` (`w:<id>` / `p:<id>`); `parseTarget` decodes it
 * back to a typed grant — split on the FIRST `:` so ids containing `:` survive,
 * and validate the prefix so a malformed value routes nowhere instead of
 * silently granting the wrong entity.
 */
const encodeTarget = (kind: 'w' | 'p', id: string) => `${kind}:${id}`;

function parseTarget(userId: string, target: string): AccessGrantVars | null {
  const sep = target.indexOf(':');
  if (sep < 1) return null;
  const kind = target.slice(0, sep);
  const id = target.slice(sep + 1);
  if (!id) return null;
  if (kind === 'w') return { userId, workspaceId: id };
  if (kind === 'p') return { userId, projectId: id };
  return null;
}
export function InvitationsTab() {
  const usersQuery = useInstanceUsers();
  const targetsQuery = useInviteTargets();
  const grantsQuery = useInstanceAccess();
  const grant = useGrantAccess();
  const revoke = useRevokeAccess();
  const invite = useInviteByEmail();

  const [inviteEmail, setInviteEmail] = useState('');
  const [userId, setUserId] = useState('');
  const [target, setTarget] = useState(''); // 'w:<id>' | 'p:<id>'

  const users = usersQuery.data ?? [];
  const targets = targetsQuery.data ?? { workspaces: [], projects: [] };
  const grants = grantsQuery.data ?? [];

  async function onGrant() {
    if (!userId || !target) return;
    const grantVars = parseTarget(userId, target);
    if (!grantVars) return; // malformed target — ignore (the picker only emits valid ones)
    try {
      await grant.mutateAsync(grantVars);
      toast.success('Access granted');
      setTarget('');
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    try {
      await invite.mutateAsync({ email });
      toast.success(`Invite sent to ${email}`);
      setInviteEmail('');
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function onRevoke(g: (typeof grants)[number]) {
    try {
      await revoke.mutateAsync(
        g.kind === 'workspace'
          ? { userId: g.userId, workspaceId: g.workspaceId }
          : { userId: g.userId, projectId: g.projectId },
      );
      toast.success('Access revoked');
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  return (
    <div className="space-y-4">
      {/* Invite a NEW person by email — they're created (as a member) when they
          click the magic link, then appear in the grant picker below. */}
      <div>
        <h3 className="mb-1 text-xs font-medium text-fg-2">Invite a new member</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-3">Email</span>
            <input
              type="email"
              className="rounded border border-border-light bg-shell px-2 py-1 text-xs"
              placeholder="teammate@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onInvite();
              }}
            />
          </label>
          <Button onClick={onInvite} disabled={!inviteEmail.trim() || invite.isPending}>
            Send invite
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-fg-3">
          We email a sign-in link. They join as a member; grant workspace/project
          access below once they appear.
        </p>
      </div>

      {/* Grant access to an EXISTING user */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-fg-3">User</span>
          <select
            className="rounded border border-border-light bg-shell px-2 py-1 text-xs"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Select a user…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-fg-3">Workspace or project</span>
          <select
            className="rounded border border-border-light bg-shell px-2 py-1 text-xs"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Select a target…</option>
            <optgroup label="Workspaces">
              {targets.workspaces.map((w) => (
                <option key={w.id} value={encodeTarget('w', w.id)}>
                  {w.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Projects">
              {targets.projects.map((p) => (
                <option key={p.id} value={encodeTarget('p', p.id)}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <Button onClick={onGrant} disabled={!userId || !target || grant.isPending}>
          Grant access
        </Button>
      </div>

      {/* Current grants roster */}
      <div>
        <h3 className="mb-1 text-xs font-medium text-fg-2">Current grants</h3>
        {grants.length === 0 ? (
          <p className="text-xs text-fg-3">No access grants yet.</p>
        ) : (
          <ul className="divide-y divide-border-light rounded-md border border-border-light">
            {grants.map((g) => (
              <li
                key={`${g.kind}:${g.userId}:${g.kind === 'workspace' ? g.workspaceId : g.projectId}`}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0 text-xs">
                  <span className="text-fg">{g.userEmail}</span>
                  <span className="text-fg-3">
                    {' '}
                    →{' '}
                    {g.kind === 'workspace'
                      ? g.workspaceName
                      : `${g.projectName} (project)`}
                  </span>
                </div>
                <button
                  type="button"
                  className="text-xs text-fg-3 hover:text-danger"
                  disabled={revoke.isPending}
                  onClick={() => onRevoke(g)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
