/**
 * Canonical MCP tool list for Phase 2 / 2.5 agents. Server's Zod schema
 * (apps/server/src/lib/agent-schema.ts) enforces tools are a subset of this
 * set; the web's agent slideover renders it as a multi-select.
 *
 * Re-exported via packages/shared so the web side can import from @folio/shared
 * without depending on apps/server.
 */

export const V1_MCP_TOOLS = [
  'list_workspaces',
  'list_projects',
  'list_documents',
  'get_document',
  'get_document_markdown',
  'create_document',
  'update_document',
  'delete_document',
  'list_statuses',
  'list_fields',
  'list_views',
  'run_view',
  // Phase 2.6 sub-phase D — agent lifecycle tools. Write tools require the
  // agents:write scope; get_agent_self is read-only metadata-on-self.
  'create_agent',
  'update_agent',
  'delete_agent',
  'get_agent_self',
  // Phase-op-3 — operator REST bridge. folio_api_get reads any token-scoped
  // route (GET-forced, maps to documents:read); folio_api writes (gated,
  // refuse-with-plan, maps to config:write — registered server-side in Task 5).
  'folio_api_get',
  'folio_api',
  // Piece B — narrow __system skills-page read. Reaches ONLY (__system, skills,
  // type=page) by construction; maps to documents:read. Any agent can PULL a
  // skill before shaping a workspace.
  'get_skill',
  // Piece B (T8) — bless/unbless a __system skill (set its trusted flag). Maps
  // to config:write; the actual T8 separation-of-duties gate (canBlessSkill)
  // lives in setSkillTrust — an MCP admin PAT (human createdBy) is refused, only
  // the system operator (createdBy null) or a session user may flip the flag.
  'set_skill_trust',
  // Operator cockpit chat (Task 3) — the `ui` tool surface. Chat-only tools that
  // render structured components (link panel / choice card) into the conversation
  // thread; both map to documents:read (emitting UI is not a privileged op).
  'show_link_panel',
  'ask_choice',
] as const;

export type McpTool = (typeof V1_MCP_TOOLS)[number];

/**
 * Grouping for UI rendering — mirrors the read/write/delete scope mapping in
 * agent-schema.ts:toolsToScopes. Keep this in sync with that function when
 * tools are added.
 */
export const MCP_TOOL_GROUPS: { label: string; tools: McpTool[] }[] = [
  {
    label: 'Read',
    tools: [
      'list_workspaces',
      'list_projects',
      'list_documents',
      'get_document',
      'get_document_markdown',
      'list_statuses',
      'list_fields',
      'list_views',
      'run_view',
      'get_skill',
    ],
  },
  {
    label: 'Write',
    tools: ['create_document', 'update_document'],
  },
  {
    label: 'Delete',
    tools: ['delete_document'],
  },
  {
    label: 'Agent lifecycle',
    tools: ['create_agent', 'update_agent', 'delete_agent', 'get_agent_self'],
  },
  {
    // Phase-op-3 — the general REST bridge. Grouped on its own because these are
    // the operator's universal primitives, not document/agent verbs: folio_api_get
    // maps to documents:read, folio_api to config:write (see toolsToScopes).
    label: 'API bridge',
    tools: ['folio_api_get', 'folio_api'],
  },
];
