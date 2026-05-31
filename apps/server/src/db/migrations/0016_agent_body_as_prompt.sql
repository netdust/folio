-- Agent prompt moves from frontmatter.system_prompt to the document body.
-- 1) Backfill body from system_prompt ONLY where body is empty/blank (no clobber).
UPDATE documents
SET body = json_extract(frontmatter, '$.system_prompt')
WHERE type = 'agent'
  AND TRIM(COALESCE(body, '')) = ''
  AND TRIM(COALESCE(json_extract(frontmatter, '$.system_prompt'), '')) <> '';

-- 2) Strip the now-legacy system_prompt key from every agent's frontmatter.
UPDATE documents
SET frontmatter = json_remove(frontmatter, '$.system_prompt')
WHERE type = 'agent'
  AND json_extract(frontmatter, '$.system_prompt') IS NOT NULL;
