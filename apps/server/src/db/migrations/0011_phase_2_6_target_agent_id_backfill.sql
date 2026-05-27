-- BUG-013 — backfill comment frontmatter.target_agent_id from target_agent.
--
-- `target_agent` has stored a slug-form reference forever (e.g. `drafter` or
-- `agent:drafter`). Renaming the target agent silently invalidated stored
-- approval/rejection rows: ApprovalButtons + Phase 3 dispatcher resolve
-- `agent.find(a => a.id === target || a.slug === target)` — once renamed,
-- neither matches and the historical approval orphans.
--
-- Mirror migration 0008's pattern: walk every approval/rejection comment
-- whose target_agent resolves to a CURRENTLY-LIVE agent in the same
-- workspace, then write that agent's id into frontmatter.target_agent_id.
-- Rows whose target_agent can't be resolved (agent deleted, ambient
-- reference, hand-edited markdown) stay without the id field — Phase 3
-- code falls back to the slug for those.
--
-- Temporal note: target_agent_id is the immutable handle, but unlike
-- migration 0008's author-id backfill there is no "slug reuse" hijack
-- vector to defend against. The target_agent is the agent the comment
-- author asked to approve/reject something; if a new agent with the same
-- slug exists at backfill time, binding to it is consistent with what a
-- user reading the comment WOULD do today. So no created_at <= comment
-- temporal guard here.

UPDATE documents AS c
SET frontmatter = json_set(
  c.frontmatter,
  '$.target_agent_id',
  (
    SELECT a.id
    FROM documents a
    WHERE a.workspace_id = c.workspace_id
      AND a.type = 'agent'
      AND (
        a.slug = json_extract(c.frontmatter, '$.target_agent')
        OR a.slug = substr(json_extract(c.frontmatter, '$.target_agent'), 7)
        OR a.id = json_extract(c.frontmatter, '$.target_agent')
        OR a.id = substr(json_extract(c.frontmatter, '$.target_agent'), 7)
      )
    ORDER BY a.created_at DESC
    LIMIT 1
  )
)
WHERE c.type = 'comment'
  AND json_extract(c.frontmatter, '$.kind') IN ('approval', 'rejection')
  AND json_extract(c.frontmatter, '$.target_agent') IS NOT NULL
  AND json_extract(c.frontmatter, '$.target_agent_id') IS NULL
  AND EXISTS (
    SELECT 1
    FROM documents a
    WHERE a.workspace_id = c.workspace_id
      AND a.type = 'agent'
      AND (
        a.slug = json_extract(c.frontmatter, '$.target_agent')
        OR a.slug = substr(json_extract(c.frontmatter, '$.target_agent'), 7)
        OR a.id = json_extract(c.frontmatter, '$.target_agent')
        OR a.id = substr(json_extract(c.frontmatter, '$.target_agent'), 7)
      )
  );
