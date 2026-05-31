# Workspace Member Management — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorm) → pending implementation plan
**Branch target:** new branch off current work (member management is independent of board-view)

## Problem

Folio is designed as "one team per instance, multiple workspaces" (CLAUDE.md) and the
briefing calls it explicitly "multi-user". The database is ready — `users`,
`memberships` (workspace-scoped, roles `owner/admin/member`), and `apiTokens` all
exist. But there is **no way through the product to add a second human to a
workspace**. When a workspace is created the creator is auto-inserted as `owner`
(`workspaces.ts`), and that is the *only* write that ever touches `memberships`. There
is no invite flow, no add/remove/role endpoints, and no members UI beyond a read-only
list (`GET /api/v1/w/:wslug/members`). The instance is effectively single-user.

This phase builds human member management: **invite by email + magic-link**, role
changes, and removal — callable by both humans (session) and agents (scoped token),
since agents are first-class users in Folio.

## Scope

**In scope**
- `workspace_invites` table + migration `0020` (+ `_journal.json` entry).
- Invite lifecycle: create / list / revoke; expiring (7 days), single-use, revocable.
- Extend magic-link consume so consuming an *invite* token joins the recipient to the
  workspace at the invited role.
- Member mutation endpoints: change role, remove member.
- A new agent tool `manage_members` → scope `members:write`, so agents can manage
  members through the API (gated by scope, not blocked).
- A "Members" panel in workspace settings: active members (inline role edit + remove),
  pending invites (revoke), invite control that **displays the returned link with a
  copy button** (email send deferred).
- Server tests for every guardrail; web tests for the panel.

**Out of scope (this phase)**
- Sending actual email / SMTP transport. The invite endpoint **returns the raw invite
  URL in the response** (mirrors how magic-link login already works — `sendMagicLink`
  is a stub). Wiring real email is a follow-up phase.
- "Leave workspace" / remove-self. Deferred — tightest surface this phase.
- Per-project membership. Membership stays workspace-scoped (projects inherit it), as
  today.
- Multi-tenancy (explicitly out of scope per CLAUDE.md — one instance = one team).

## Decisions (locked in brainstorm)

| Question | Decision |
|---|---|
| How people get added | Invite by email + magic-link |
| Link delivery | Return link in API response now; email later. API path matters because **agents must be able to add people too**. |
| Email scope this phase | Return link only — no SMTP build |
| Who can manage | Owner + admin manage; member is read-only |
| Guardrails | Can't remove/demote last owner; only owners may grant/revoke `owner`; can't change your own role |
| Agents managing members | **Allowed** — agents can do everything in the app, gated by the `members:write` scope (not session-only) |
| Invite lifecycle | Expiring (7d) + revocable + single-use + listed alongside members |

## Data model

New table `workspace_invites` (migration `0020_workspace_invites.sql`):

| column | type | notes |
|---|---|---|
| `id` | text PK | `nanoid()` (matches magic_links / existing id pattern) |
| `workspace_id` | text NOT NULL | FK → `workspaces.id`, `onDelete: cascade` |
| `email` | text NOT NULL | invited address, **stored lowercased** |
| `role` | text NOT NULL | enum `owner/admin/member` — role granted on join |
| `token_hash` | text NOT NULL | `hashToken(rawToken)` (sha256 hex). Raw token never stored. |
| `invited_by` | text NULL | FK → `users.id`, `onDelete: set null`. NULL when created by an agent token with no resolvable user. |
| `expires_at` | integer (timestamp_ms) NOT NULL | created_at + 7 days |
| `consumed_at` | integer (timestamp_ms) NULL | set on accept; single-use |
| `revoked_at` | integer (timestamp_ms) NULL | set on revoke |
| `created_at` | integer (timestamp_ms) NOT NULL | default `(unixepoch() * 1000)` |

Indexes:
- `unique index workspace_invites_token_idx on (token_hash)` — token lookup at consume,
  mirrors `magic_links_token_idx`.
- `unique partial index workspace_invites_pending_idx on (workspace_id, email) where consumed_at is null and revoked_at is null` —
  prevents two *live* invites to the same email in the same workspace. (Expired-but-not-consumed
  rows remain, so the partial predicate does NOT include expiry — re-inviting an expired
  invite first revokes/deletes the stale row, or we treat an expired pending row as
  re-creatable; see "Edge cases".)

Drizzle: add the table to `schema.ts`, generate via `db:generate`, then **manually add
the idx-20 entry to `meta/_journal.json`** (tag `0020_workspace_invites`) — `migrate()`
silently skips files not in the journal (known lesson).

## Token scope (agents)

Scopes are derived from agent **tools** via `toolsToScopes()` in
`apps/server/src/lib/agent-schema.ts`, not free-form strings. Add:

```ts
const MEMBER_TOOLS: ReadonlySet<string> = new Set(['manage_members']);
// in toolsToScopes(): if (MEMBER_TOOLS.has(tool)) scopes.add('members:write');
```

The new scope string is `members:write`. All member/invite mutation routes are guarded
by `requireScope('members:write')`. Because `requireScope` already **bypasses scope
checks for session (human) callers** (`bearer.ts` — "membership is the gate"), the same
middleware gives us the dual human/agent path for free: humans gated by role, agents
gated by scope **and** by the membership their token resolves to.

## Endpoints

All under the existing `workspaceItemRoute` (`/api/v1/w/:wslug`), after
`resolveWorkspace` (which sets `workspace` + `role` and rejects non-members / wrong-workspace
tokens). Validation via Zod schemas in `packages/shared`.

| method | path | guard | behavior |
|---|---|---|---|
| `GET` | `/members` | member+ | **exists** — unchanged |
| `PATCH` | `/members/:userId` | owner/admin + `members:write` | change a member's role |
| `DELETE` | `/members/:userId` | owner/admin + `members:write` | remove a member |
| `GET` | `/invites` | owner/admin | list pending invites (not consumed, not revoked) |
| `POST` | `/invites` | owner/admin + `members:write` | create invite → returns `{ invite: {...}, url }` with the **raw token URL** |
| `DELETE` | `/invites/:id` | owner/admin + `members:write` | revoke a pending invite (set `revoked_at`) |

Plus extend the existing **`GET /api/v1/auth/magic-link/consume`**:

1. Hash the token, look it up in `magic_links` first (current behavior, unchanged).
2. If not found there, look it up in `workspace_invites` by `token_hash`.
3. If an invite row matches and is **live** (not consumed, not revoked, not expired):
   - find-or-create the user by `email` (same upsert as today);
   - **insert membership** `(workspace_id, user_id, role=invite.role)` if not already a
     member (if already a member, leave existing role untouched — accepting an invite
     never downgrades);
   - set `consumed_at`;
   - emit `workspace.member_added` event;
   - create session + set cookie + redirect `/` (same tail as today).
   All inside `txWithEvents`.
4. Invalid/expired/consumed/revoked invite token → `INVALID_TOKEN` 400 (same shape as
   magic-link).

**Invite URL format:** `${origin}/api/v1/auth/magic-link/consume?token=${rawToken}` —
reuses the consume route. (Single consume endpoint handles both login links and invite
links by table lookup order.)

### Response shapes (in `packages/shared`)
- `POST /invites` → `{ invite: { id, email, role, expiresAt, createdAt }, url }`
- `GET /invites` → `{ invites: [{ id, email, role, invitedBy, expiresAt, createdAt }] }`
- `PATCH /members/:userId` → `{ member: { id, email, name, role } }`
- `DELETE /members/:userId` → `{ ok: true }`
- `DELETE /invites/:id` → `{ ok: true }`

## Authorization rules (server-enforced, each individually tested)

Let `actorRole = getRole(c)`; for agents this is the role of the membership their token
resolves to.

1. **Manage gate:** `actorRole` must be `owner` or `admin` for any mutation. `member` →
   `FORBIDDEN` 403.
2. **Last owner:** removing or demoting a user whose role is `owner` is rejected with
   `LAST_OWNER` 409 if they are the only `owner` in the workspace. (Count owners in the
   same transaction.)
3. **Owner grant:** setting a role *to* `owner`, or changing a role *from* `owner`,
   requires `actorRole === 'owner'`. An admin attempting either → `FORBIDDEN` 403.
4. **No self-role-edit:** `PATCH /members/:userId` where `:userId === actingUser.id` →
   `FORBIDDEN` 403. (For agent tokens, "self" = the user the token resolves to. Agents
   editing others is fine.)
5. **Invite role ceiling:** an admin cannot create an invite with `role: 'owner'` (same
   rule as #3) → `FORBIDDEN` 403.
6. **Project-narrowed agents:** the existing `/members` rule (Round 7 #22) returns an
   empty member list to a project-narrowed agent bearer. Mutation endpoints reject
   project-narrowed agents outright (`FORBIDDEN` 403) — a token scoped to specific
   projects has no business managing workspace-level membership.

## Events

Every mutation emits on the same transaction via `emitEvent(tx, …)` inside
`txWithEvents`:

- `workspace.member_invited` — on `POST /invites` (payload: email, role)
- `workspace.invite_revoked` — on `DELETE /invites/:id`
- `workspace.member_added` — on invite consume (payload: userId, role)
- `workspace.member_role_changed` — on `PATCH /members/:userId` (payload: userId, from, to)
- `workspace.member_removed` — on `DELETE /members/:userId` (payload: userId)

New event kinds added to the `EventKind` union in `events.ts`.

## Frontend

A **Members** section in workspace settings, following existing settings/rail patterns
and UX commitments (inline edit, optimistic writes, slideovers not modals, toasts on
error):

- **Active members list:** email + name + role. Role is an inline `<select>` (owner/
  admin/member) — owners see all options; admins can't pick `owner`; the row for the
  acting user has role disabled (self-edit guard). Remove (×) action per row, hidden/
  disabled for the last owner and for self.
- **Pending invites list:** email + role + expiry; revoke action each.
- **Invite control:** email input + role select → `POST /invites`. On success, show the
  returned `url` in a copyable field with a "Copy link" button and a note that email
  delivery is coming. (This is the actual delivery mechanism this phase.)
- Optimistic updates with rollback on error. React-query mutations following the
  existing pattern in the web app.

## Edge cases

- **Re-invite to a live pending invite:** rejected by the partial unique index →
  surface as `INVITE_EXISTS` 409. UI should revoke-then-reinvite, or we revoke the old
  one server-side in `POST /invites` before inserting (decide in plan; leaning
  server-side revoke-and-replace for nicer UX).
- **Re-invite after expiry:** an expired pending row still trips the partial index
  (predicate excludes expiry by design). `POST /invites` deletes/revokes any existing
  pending row for `(workspace, email)` before inserting, so re-invite always works.
- **Invite for an existing member:** allowed to create, but on consume we no-op the
  membership insert (already a member) and still mark consumed. Optionally short-circuit
  in `POST /invites` with `ALREADY_MEMBER` 409 — decide in plan (leaning: allow, since
  the invitee might be re-confirming an email).
- **Workspace deleted with pending invites:** `onDelete: cascade` cleans them up.
- **Inviter removed before consume:** `invited_by` FK `set null`; invite still works.

## Testing

Server (run from **inside `apps/server`** — `cd apps/server && bun test`, per the
full-suite cascade lesson):
- migration `0020` applies; table + both indexes exist (migration test bypasses journal
  per lesson).
- create invite (owner, admin); admin cannot invite as owner.
- duplicate live invite → 409; re-invite after expiry succeeds (replace path).
- list invites; revoke invite; revoked/expired/consumed invite cannot be consumed.
- consume invite: new user created + joined at role; existing user joined; already-member
  no-ops role; session created; event emitted.
- PATCH role: admin↔member by admin ok; to/from owner requires owner; self-edit 403;
  member caller 403.
- DELETE member: last-owner 409; demote last owner 409; member caller 403.
- agent token with `members:write` can invite/patch/delete; without it → 403;
  project-narrowed agent → 403; token from another workspace → 403 (existing
  `resolveWorkspace` check).
- every mutation emits the expected event kind.

Web (vitest, `npx vitest run`): Members panel renders members + invites; role select
disabled for self and constrained for admins; invite flow shows copyable URL; optimistic
update + rollback on error.

Type-check per app (`bun x tsc --noEmit` in each app — root has no tsconfig).

## Threat model

This touches an auth/token surface (invite tokens), untrusted input (invitee email,
role), the multi-user authorization boundary, and a privilege-escalation-prone area
(role changes). Per the project's CLAUDE.md rule #2, a threat model is required.

### Assets
- Workspace membership (who can read/write a workspace's documents).
- The `owner` role (full control, including removing others and deleting the workspace).
- Invite tokens (a valid token grants workspace access on consume).

### Trust boundaries
- Anonymous holder of an invite URL → becomes a member on consume.
- Authenticated member (any role) → may attempt mutations beyond their role.
- Agent token holder → may attempt member mutations beyond its scope/binding.

### Attacks & mitigations

| # | Attack | Mitigation |
|---|---|---|
| T1 | **Privilege escalation: admin grants self/other `owner`** | Rule #3 (owner-grant) — only owners set/clear `owner`. Tested. |
| T2 | **Self-promotion via PATCH own role** | Rule #4 (no self-role-edit) — 403 on `:userId === self`. Tested. |
| T3 | **Workspace lockout: remove/demote last owner** | Rule #2 (last-owner) — owner count checked in-tx, 409. Tested. |
| T4 | **Member (read-only) mutates membership** | Rule #1 (manage gate) — `member` → 403 on all mutations. Tested. |
| T5 | **Invite token guessing / brute force** | Token is `nanoid(32)` (same entropy as magic-link login tokens); only the sha256 hash is stored; lookup is constant-shape. |
| T6 | **Stolen/leaked invite link reused** | Single-use (`consumed_at`) + 7-day expiry + revocable (`revoked_at`). A consumed or revoked link is dead. |
| T7 | **Standing-link risk** | No non-expiring invites — every invite expires in 7 days (rejected design alternative). |
| T8 | **Cross-workspace token use** | `resolveWorkspace` already rejects a token whose `workspaceId` ≠ the resolved workspace (403). Reused unchanged. |
| T9 | **Agent over-reach** | Member mutations require `members:write` scope (absent by default — only granted if the agent's tools include `manage_members`). Project-narrowed agents rejected (rule #6). Agent still bound to its membership's role for rules #2/#3. |
| T10 | **Invite-token confusion with login magic-links** | Consume checks `magic_links` first, then `workspace_invites`; both are single-use and hash-stored; a token matches at most one table (independent random tokens). No type-confusion grants extra privilege — invite path only ever grants the invite's role. |
| T11 | **Email injection / role tampering in invite payload** | Zod validation: `email` is `.email()` and lowercased; `role` is the enum. No interpolation of email into SQL (Drizzle params). |
| T12 | **Enumeration of members by project-narrowed agent** | Existing Round 7 #22 rule returns empty member list to project-narrowed agents; extended to reject their mutations too. |

### Residual risks (accepted)
- Invite URL is returned in the API response and shown in the UI this phase (no email).
  Whoever can see the response can use the link — acceptable because the caller is
  already an owner/admin (or a `members:write` agent) of that workspace. Documented as
  the deliberate "email later" tradeoff.
- No rate-limiting on invite creation in v1 (consistent with the rest of the app, which
  has none yet). Noted for a future hardening pass.

## Open question carried into the plan
- `POST /invites` behavior on existing-live-invite and on already-member: lean
  revoke-and-replace for the former, allow-and-no-op for the latter. Finalize in the
  plan's task breakdown.
