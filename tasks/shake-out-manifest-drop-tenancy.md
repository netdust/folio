# Shake-out manifest — drop-workspace-tenancy (spec-complete gate, 2026-06-05)

Sweep: integration green; e2e 28-pass (3 PRE-EXISTING stale-Wiki-tab/agent-picker
failures, identical on main, NOT this branch); API-level sweep of the new Phase-5
surfaces (first-user→owner, roles, invitations grant→see→revoke→denied, self-demote
+ owner-only role gates, instance-admin gates) ALL PASS. 4-reviewer panel run.

## BLOCKER
- [ ] B1 — MCP human-PAT cross-project leak. agent-tools-registry.ts:
  resolveProjectInWorkspace(~170) + list_projects(~466) + query_documents(~591) +
  describe_workspace(~645) gate project visibility ONLY when token.agentId is set.
  A human PAT (agentId null) skips the gate → a project-only invitee who minted a
  ws-pinned PAT reads+writes sibling projects. CR-7/CR-9 narrowing never reached
  the MCP layer. Fix: narrow non-agent branch by visibleProjectIds / canSeeProject
  keyed on token.createdBy (mirror the HTTP fix). Security-confirmed reachable.

## SHOULD-FIX
- [ ] S1 — comments.ts loadWorkspaceAgents (~218-240): dead __system UNION + @mention
  resolution not instance-wide (inconsistent with runs/trigger resolveAgentForRun).
- [ ] S2 — triple userRole read per non-owner request (scope.ts + canSeeWorkspace/
  canSeeProject each re-query). Thread the resolved role into the helpers.
- [ ] S3 — stale comments: runner loadAgentDefinition docblock; instance-access.ts
  file header (claims no roster endpoint — false); agent-tools-registry __system
  comments + set_skill_trust tool description.

## NICE-TO-HAVE
- [ ] N1 — dead exports OPERATOR_AGENT_TITLE + SETUP_PROJECT_REF_BODY (+ their
  keep-alive tests).
- [ ] N2 — setSkillTrust emits no audit event (security state change, no trail).
- [ ] N3 — listWorkspaces re-derives canSeeWorkspace inline → add visibleWorkspaceIds
  to access.ts (invariant 4a).
- [ ] N4 — listWorkspaces serial direct+viaProject reads → Promise.all.
- [ ] N5 — last-owner-guard comment says "indexed users.role" (no index). Fix comment.

## RESOLUTION (2026-06-05)
- B1 — FIXED (`192b04d`): humanPatProjectCeiling helper; resolveProjectInWorkspace
  + list_projects + find_documents + describe_workspace narrow a human PAT to its
  project_access grants. 3 RED-first tests.
- S1 — FIXED: comments.ts loadWorkspaceAgents resolves agents INSTANCE-WIDE (drops
  the dead __system union; mention resolution now matches the runs/trigger paths).
- S2 — FIXED: canSeeWorkspace/canSeeProject/canManageWorkspace take optional role;
  scope.ts threads the resolved role → 3→1 userRole reads per non-owner request.
- S3 — FIXED: de-staled runner loadAgentDefinition docblock, instance-access.ts
  header, set_skill_trust description, last-owner "indexed" comment.
- N1 — FIXED: removed dead OPERATOR_AGENT_TITLE + SETUP_PROJECT_REF_BODY + tests.
- N3 — FIXED: visibleWorkspaceIds added to access.ts (invariant 4a); listWorkspaces
  routes through it.
- N4 — FIXED: visibleWorkspaceIds parallelizes the two reads (Promise.all).
- N5 — FIXED: last-owner comment no longer claims an index on users.role.
- N2 — DEFERRED (tracked): setSkillTrust emits no audit event. An instance-level
  skill.trust.changed event has no workspace home, and events.workspace_id is
  notNull+FK — re-adding it would reintroduce the exact coupling D-B removed (the
  dropped __system-scoped event). Revisit if/when instance-level events get a home
  (nullable events.workspace_id + an instance-broadcast SSE filter). No consumer
  today; the trust flip itself is gated by canBlessSkill + the typed column.

Gates after fixes: server 1476/1-skip/0, web 772/8-skip/0, tsc clean ×3, e2e 28-pass
(3 pre-existing stale-spec failures, not this branch). Manual sweep of the new
Phase-5 surfaces (first sweep) PASSED.
