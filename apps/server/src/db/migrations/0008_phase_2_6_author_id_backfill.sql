-- Phase 2.6 review fix G6 — backfill comment authors from `agent:<slug>` to
-- `agent:<id>`.
--
-- F11 changed the canonical author form for NEW comments. Pre-F11 rows still
-- carry `agent:<slug>` and rely on assertAuthor's slug back-compat path, which
-- is a privilege-escalation vector: hard-deleting agent A frees slug 'foo';
-- creating a new agent B with the same slug lets B edit A's old comments.
--
-- The migration walks every comment whose author starts with `agent:` and
-- whose suffix matches a CURRENTLY-LIVE agent's slug in the same workspace,
-- then rewrites the suffix to that agent's id.
--
-- H5 — TEMPORAL CONSTRAINT: only rewrite when the matched agent was
-- created BEFORE OR AT the comment's createdAt. If the agent is NEWER
-- than the comment, the slug was reused (original agent deleted, new
-- agent created with the same slug) and rewriting would BAKE IN the very
-- hijack the back-compat removal was meant to prevent. Comments that
-- can't backfill stay in slug form and become permanently uneditable
-- (assertAuthor's slug branch was removed) — that's the security
-- property, not a UX regression.

UPDATE documents AS c
SET frontmatter = json_set(
  c.frontmatter,
  '$.author',
  'agent:' || (
    SELECT a.id
    FROM documents a
    WHERE a.workspace_id = c.workspace_id
      AND a.type = 'agent'
      AND a.slug = substr(json_extract(c.frontmatter, '$.author'), 7)
      AND a.created_at <= c.created_at
    ORDER BY a.created_at ASC
    LIMIT 1
  )
)
WHERE c.type = 'comment'
  AND substr(json_extract(c.frontmatter, '$.author'), 1, 6) = 'agent:'
  AND EXISTS (
    SELECT 1
    FROM documents a
    WHERE a.workspace_id = c.workspace_id
      AND a.type = 'agent'
      AND a.slug = substr(json_extract(c.frontmatter, '$.author'), 7)
      AND a.created_at <= c.created_at
  );
