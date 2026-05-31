-- Phase 3 (Task A-3): flip the two runner-bound built-in triggers from
-- enabled=false to enabled=true. Phase 2.6 seeded them disabled because
-- no runner existed. Idempotent: rows already at enabled=true match
-- nothing in the WHERE clause.
UPDATE documents
SET frontmatter = json_set(frontmatter, '$.enabled', json('true')),
    updated_at = unixepoch() * 1000
WHERE type = 'trigger'
  AND json_extract(frontmatter, '$.builtin') = 1
  AND slug IN ('builtin-on-assignment', 'builtin-on-mention')
  AND json_extract(frontmatter, '$.enabled') = 0;
