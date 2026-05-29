/**
 * Phase 3 Sub-phase D — Task D-6: GET /admin/runner-stats.
 *
 * Workspace-scoped, admin-only aggregate runner counts. Mounted under
 * `wScope` at `/admin/runner-stats`, so `resolveWorkspace` has already
 * attached the workspace + the caller's membership role.
 *
 * Threat-model mitigation 60 — admin-only (owner/admin role) + workspace-
 * aggregate counts ONLY. No per-agent, no per-project, no run ids, no tenant
 * content. No MCP twin (this router is mounted on the HTTP wScope only).
 *
 * The three counts are computed with workspace-scoped SQL directly in the
 * route. We deliberately do NOT use the service-layer `countPendingPlanning`
 * helper for `pending_count`: it is GLOBAL (no workspace filter) and would
 * leak cross-workspace counts, violating mitigation 60.
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { type AuthContext } from '../middleware/auth.ts';
import { type ScopeContext, getRole, getWorkspace } from '../middleware/scope.ts';

export const adminRunnerStatsRoute = new Hono<AuthContext & ScopeContext>();

adminRunnerStatsRoute.get('/', async (c) => {
  // Mitigation 60 — admin-only. resolveWorkspace (wScope) attached the
  // caller's membership role; gate before reading any counts. Mirrors the
  // inline owner/admin check used by settings.ts.
  const role = getRole(c);
  if (role !== 'owner' && role !== 'admin') {
    throw new HTTPError('FORBIDDEN', 'admin only', 403);
  }

  const ws = getWorkspace(c);

  // pending_count — agent_run rows at status='planning' in THIS workspace.
  // Predicate on the indexed `status` column (not frontmatter JSON), scoped
  // by workspace_id (this is what makes it NOT the global helper).
  const pendingRows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM documents
     WHERE type = 'agent_run'
       AND status = 'planning'
       AND workspace_id = ${ws.id}
  `);
  const pendingCount = pendingRows[0]?.count ?? 0;

  // active_count — agent_run rows at status running OR awaiting_approval in
  // this workspace.
  const activeRows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM documents
     WHERE type = 'agent_run'
       AND status IN ('running', 'awaiting_approval')
       AND workspace_id = ${ws.id}
  `);
  const activeCount = activeRows[0]?.count ?? 0;

  // recovered_today — orphan-recovery failures since UTC midnight today.
  // events.created_at is INTEGER ms epoch — bind a number, not a Date.
  // Date.UTC(y, m, d) gives ms at UTC midnight for today's date.
  const now = new Date();
  const utcMidnightMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const recoveredRows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM events
     WHERE kind = 'agent.run.failed'
       AND workspace_id = ${ws.id}
       AND json_extract(payload, '$.error_reason') = 'worker_crash'
       AND created_at >= ${utcMidnightMs}
  `);
  const recoveredToday = recoveredRows[0]?.count ?? 0;

  return jsonOk(c, {
    pending_count: pendingCount,
    active_count: activeCount,
    recovered_today: recoveredToday,
  });
});
