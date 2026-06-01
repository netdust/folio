-- D10: existing agent_run docs predate caller-authority. Stamp them with a
-- fail-closed empty snapshot so the required schema fields are present and a
-- stranded non-terminal run that ever resumes gets deny-all (never escalation).
-- caller_scopes is only read by the runner on tool dispatch (non-terminal runs);
-- terminal historical runs never re-dispatch, so [] is inert for them and safe
-- for the rest. Pure SQL — no apiTokens join.
UPDATE documents
SET frontmatter = json_set(
  frontmatter,
  '$.caller_scopes', json('[]'),
  '$.caller_project_ids', json('null')
)
WHERE type = 'agent_run'
  AND json_extract(frontmatter, '$.caller_scopes') IS NULL;
