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
];
