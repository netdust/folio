/**
 * Route tests for GET /api/v1/w/:wslug/admin/runner-stats (Task D-6).
 *
 * Real DB via makeTestApp. Covers:
 *  - member role → 403 (mitigation 60 admin-only gate)
 *  - owner → 200 with EXACTLY {pending_count, active_count, recovered_today}
 *  - admin role → 200 (also allowed)
 *  - count correctness across planning / running / awaiting_approval rows +
 *    a worker_crash failure event dated today
 *  - workspace scoping (mitigation 60): a SECOND workspace's runs/events do
 *    NOT bleed into the first workspace's stats
 */

import { test, expect, describe } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import {
  documents,
  events,
  projects,
  tables,
  users,
  workspaceAccess,
  workspaces,
  type Project,
  type TableEntity,
  type Workspace,
} from '../db/schema.ts';
import { apiTokens } from '../db/schema.ts';
import { createSession, hashPassword, newApiToken } from '../lib/auth.ts';
import type { RunStatus } from '../lib/agent-run-schema.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

async function seedRunsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const id = nanoid();
  await db.insert(tables).values({ id, projectId, slug: `runs-${nanoid(6)}`, name: 'Runs' });
  const t = await db.query.tables.findFirst({ where: eq(tables.id, id) });
  return t!;
}

async function seedParent(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  table: TableEntity,
  userId: string,
): Promise<string> {
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: table.id,
    type: 'work_item',
    slug: `wi-${nanoid(6)}`,
    title: 'Parent',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: userId,
    updatedBy: userId,
  });
  return id;
}

/** Insert an agent_run document at the given status, workspace-scoped. */
async function seedRun(
  db: TestDB,
  args: {
    workspace: Workspace;
    project: Project;
    runsTable: TableEntity;
    parentId: string;
    userId: string;
    status: RunStatus;
  },
): Promise<void> {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(documents).values({
    id,
    workspaceId: args.workspace.id,
    projectId: args.project.id,
    tableId: args.runsTable.id,
    type: 'agent_run',
    slug: `agent-${now.replace(/:/g, '-')}-${nanoid(8)}`,
    title: 'run',
    status: args.status,
    body: '',
    frontmatter: {
      assignee: 'agent:helper',
      status: args.status,
      agent_slug: 'helper',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system_prompt: 'x',
      max_tokens: 1000,
      tokens_in: 0,
      tokens_out: 0,
      trigger_id: null,
      chain_id: crypto.randomUUID(),
      fired_by: 'manual',
      started_at: now,
    },
    parentId: args.parentId,
    createdBy: args.userId,
    updatedBy: args.userId,
  });
}

// events.seq carries a UNIQUE index; hand-seeded events need distinct values.
let seqCounter = 0;

/** Insert an agent.run.failed event with the given error_reason + createdAt. */
async function seedFailedEvent(
  db: TestDB,
  args: { workspaceId: string; errorReason: string; createdAt: Date },
): Promise<void> {
  seqCounter += 1;
  await db.insert(events).values({
    id: nanoid(),
    workspaceId: args.workspaceId,
    projectId: null,
    documentId: nanoid(),
    kind: 'agent.run.failed',
    actor: 'system:orphan-recovery',
    payload: { error_reason: args.errorReason } as unknown as Record<string, unknown>,
    createdAt: args.createdAt,
    seq: seqCounter,
  });
}

/** Seed a second, fully-isolated workspace. Its user is only a document author
 * (createdBy/updatedBy) — never authenticated — so it needs no authority grant. */
async function seedSecondWorkspace(
  db: TestDB,
): Promise<{ workspace: Workspace; project: Project; runsTable: TableEntity; userId: string }> {
  const userId = nanoid();
  await db.insert(users).values({
    id: userId,
    email: `u-${nanoid(6)}@test.local`,
    name: 'Bob',
    passwordHash: await hashPassword('password123'),
  });
  const wsId = nanoid();
  await db.insert(workspaces).values({ id: wsId, slug: `other-${nanoid(6)}`, name: 'Other' });
  const projId = nanoid();
  await db.insert(projects).values({ id: projId, workspaceId: wsId, slug: 'other-web', name: 'OW' });
  const workspace = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) }))!;
  const project = (await db.query.projects.findFirst({ where: eq(projects.id, projId) }))!;
  const runsTable = await seedRunsTable(db, projId);
  return { workspace, project, runsTable, userId };
}

/** Add a member-role user to the seeded workspace, return its session cookie. */
async function seedMemberUser(db: TestDB, workspaceId: string): Promise<string> {
  const userId = nanoid();
  await db.insert(users).values({
    id: userId,
    email: `m-${nanoid(6)}@test.local`,
    name: 'Member',
    passwordHash: await hashPassword('password123'),
  });
  // Post-tenancy: a workspace_access grant lets this member PAST resolveWorkspace
  // so the test exercises the handler's admin-only gate (not the ws gate). role
  // stays the users.role default 'member', so the handler still 403s.
  await db.insert(workspaceAccess).values({ userId, workspaceId });
  const session = await createSession(userId);
  return `folio_session=${session.id}`;
}

const URL = '/api/v1/w/acme/admin/runner-stats';

describe('GET /admin/runner-stats', () => {
  test('member role → 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedMemberUser(db, seed.workspace.id);

    const res = await app.request(URL, { headers: { cookie: memberCookie } });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('owner → 200 with exactly the three keys', async () => {
    const { app, seed } = await makeTestApp();

    const res = await app.request(URL, { headers: { cookie: seed.sessionCookie } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual([
      'active_count',
      'pending_count',
      'recovered_today',
    ]);
    expect(body.data).toEqual({ pending_count: 0, active_count: 0, recovered_today: 0 });
  });

  test('admin role → 200', async () => {
    const { app, db, seed } = await makeTestApp();
    // Promote a fresh user to admin. Post-tenancy: the admin gate reads
    // users.role, so set the INSTANCE role to 'admin'; a workspace_access grant
    // lets it past resolveWorkspace.
    const userId = nanoid();
    await db.insert(users).values({
      id: userId,
      email: `a-${nanoid(6)}@test.local`,
      name: 'Admin',
      passwordHash: await hashPassword('password123'),
      role: 'admin',
    });
    await db.insert(workspaceAccess).values({ userId, workspaceId: seed.workspace.id });
    const session = await createSession(userId);

    const res = await app.request(URL, {
      headers: { cookie: `folio_session=${session.id}` },
    });

    expect(res.status).toBe(200);
  });

  test('Finding 4: bearer token (creator is owner) → 403 (session-only, mit 60)', async () => {
    const { app, db, seed } = await makeTestApp();
    // Mint a bearer token whose CREATOR is the seeded owner. getRole would
    // resolve the creator's owner role and let it through — but the endpoint is
    // UI/ops-only, so a token (any token) must be rejected as not session-auth.
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'agent:stats-probe',
      tokenHash: hash,
      scopes: ['documents:read', 'agents:write'],
      agentId: null,
      createdBy: seed.user.id, // an OWNER mints it
    });

    const res = await app.request(URL, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('counts are correct across statuses + today worker_crash events', async () => {
    const { app, db, seed } = await makeTestApp();
    const runsTable = await seedRunsTable(db, seed.project.id);
    const parentId = await seedParent(db, seed.workspace, seed.project, runsTable, seed.user.id);
    const common = {
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      parentId,
      userId: seed.user.id,
    };

    // 2 planning, 1 running, 1 awaiting_approval (active=2), 1 completed (ignored).
    await seedRun(db, { ...common, status: 'planning' });
    await seedRun(db, { ...common, status: 'planning' });
    await seedRun(db, { ...common, status: 'running' });
    await seedRun(db, { ...common, status: 'awaiting_approval' });
    await seedRun(db, { ...common, status: 'completed' });

    // 3 worker_crash failures today, 1 with a different reason (ignored),
    // 1 worker_crash dated yesterday (ignored — before UTC midnight).
    const today = new Date();
    await seedFailedEvent(db, {
      workspaceId: seed.workspace.id,
      errorReason: 'worker_crash',
      createdAt: today,
    });
    await seedFailedEvent(db, {
      workspaceId: seed.workspace.id,
      errorReason: 'worker_crash',
      createdAt: today,
    });
    await seedFailedEvent(db, {
      workspaceId: seed.workspace.id,
      errorReason: 'worker_crash',
      createdAt: today,
    });
    await seedFailedEvent(db, {
      workspaceId: seed.workspace.id,
      errorReason: 'provider_error',
      createdAt: today,
    });
    await seedFailedEvent(db, {
      workspaceId: seed.workspace.id,
      errorReason: 'worker_crash',
      createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000), // ~yesterday
    });

    const res = await app.request(URL, { headers: { cookie: seed.sessionCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, number> };
    expect(body.data).toEqual({ pending_count: 2, active_count: 2, recovered_today: 3 });
  });

  test('mitigation 60 — counts do not leak across workspaces', async () => {
    const { app, db, seed } = await makeTestApp();
    const runsTable = await seedRunsTable(db, seed.project.id);
    const parentId = await seedParent(db, seed.workspace, seed.project, runsTable, seed.user.id);

    // First workspace: 1 planning, 1 running, 1 worker_crash today.
    await seedRun(db, {
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      parentId,
      userId: seed.user.id,
      status: 'planning',
    });
    await seedRun(db, {
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      parentId,
      userId: seed.user.id,
      status: 'running',
    });
    await seedFailedEvent(db, {
      workspaceId: seed.workspace.id,
      errorReason: 'worker_crash',
      createdAt: new Date(),
    });

    // Second workspace: pile on extra runs + events that MUST NOT be counted.
    const other = await seedSecondWorkspace(db);
    const otherParent = await seedParent(db, other.workspace, other.project, other.runsTable, other.userId);
    for (let i = 0; i < 5; i++) {
      await seedRun(db, {
        workspace: other.workspace,
        project: other.project,
        runsTable: other.runsTable,
        parentId: otherParent,
        userId: other.userId,
        status: 'planning',
      });
      await seedRun(db, {
        workspace: other.workspace,
        project: other.project,
        runsTable: other.runsTable,
        parentId: otherParent,
        userId: other.userId,
        status: 'running',
      });
      await seedFailedEvent(db, {
        workspaceId: other.workspace.id,
        errorReason: 'worker_crash',
        createdAt: new Date(),
      });
    }

    const res = await app.request(URL, { headers: { cookie: seed.sessionCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, number> };
    // Exactly the first workspace's counts — none of the second's.
    expect(body.data).toEqual({ pending_count: 1, active_count: 1, recovered_today: 1 });
  });
});
