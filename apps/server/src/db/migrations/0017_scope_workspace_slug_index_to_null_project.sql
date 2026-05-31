-- BUGFIX: `documents_workspace_type_slug_idx` was a UNIQUE index on
-- (workspace_id, type, slug) with NO partial predicate. It exists to keep
-- workspace-SCOPED documents (agents + triggers, which always have
-- project_id IS NULL) unique per (workspace, type, slug). But because it had
-- no WHERE clause it ALSO constrained project-scoped work_items/pages — so a
-- work_item slug like 'untitled' in project A collided with an 'untitled'
-- work_item in project B of the SAME workspace, even though they are different
-- projects. The slug-dedup at create time only checks (project_id, slug)
-- uniqueness (documents_project_slug_idx), so it passed while the DB rejected
-- the insert → 500 on "New work item" whenever any same-slug work_item/page
-- existed elsewhere in the workspace.
--
-- Fix: make the workspace index PARTIAL — enforce it only for project-less rows
-- (agents/triggers). Work_items/pages keep their correct per-project uniqueness
-- via documents_project_slug_idx and are no longer constrained workspace-wide.
DROP INDEX IF EXISTS `documents_workspace_type_slug_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `documents_workspace_type_slug_idx` ON `documents` (`workspace_id`,`type`,`slug`) WHERE `project_id` IS NULL;
