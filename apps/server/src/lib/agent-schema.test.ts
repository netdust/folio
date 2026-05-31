import { describe, test, expect } from 'bun:test';
import { agentFrontmatterSchema, toolsToScopes, V1_MCP_TOOLS } from './agent-schema.ts';

describe('agentFrontmatterSchema', () => {
  test('accepts a complete valid agent frontmatter', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'do the thing',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: ['list_documents', 'get_document'],
      max_delegation_depth: 2,
      max_tokens_per_run: 10000,
      requires_approval: false,
    });
    expect(r.success).toBe(true);
  });

  test('agent frontmatter validates without system_prompt (body is the prompt now)', () => {
    const result = agentFrontmatterSchema.safeParse({
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      tools: [],
      projects: ['*'],
    });
    expect(result.success).toBe(true);
  });

  test('applies defaults for max_delegation_depth, max_tokens_per_run, requires_approval', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x',
      model: 'gpt-4o',
      provider: 'openai',
      tools: [],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.max_delegation_depth).toBe(2);
      expect(r.data.max_tokens_per_run).toBe(10000);
      expect(r.data.requires_approval).toBe(false);
    }
  });

  test('rejects max_delegation_depth > 5', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], max_delegation_depth: 6,
    });
    expect(r.success).toBe(false);
  });

  test('rejects max_tokens_per_run > 100000', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], max_tokens_per_run: 100001,
    });
    expect(r.success).toBe(false);
  });

  test('rejects unknown provider', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'magic', tools: [],
    });
    expect(r.success).toBe(false);
  });

  test('rejects tools not in the v1 MCP set', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: ['list_documents', 'invent_thing'],
    });
    expect(r.success).toBe(false);
  });

  test('rejects api_token_id when set by the client on input', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], api_token_id: 'tok_x',
    });
    expect(r.success).toBe(false);
  });

  test('rejects parent_agent when set by the client on input', () => {
    const r = agentFrontmatterSchema.safeParse({
      system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [], parent_agent: 'agent-foo',
    });
    expect(r.success).toBe(false);
  });
});

describe('agentFrontmatterSchema.projects', () => {
  const base = {
    system_prompt: 'p',
    model: 'claude-opus-4-7',
    provider: 'anthropic' as const,
    tools: ['list_documents'],
  };

  test('defaults projects to ["*"]', () => {
    const r = agentFrontmatterSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.projects).toEqual(['*']);
  });

  test('accepts explicit ["*"]', () => {
    const r = agentFrontmatterSchema.safeParse({ ...base, projects: ['*'] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.projects).toEqual(['*']);
  });

  test('accepts an explicit list of project ids', () => {
    const r = agentFrontmatterSchema.safeParse({ ...base, projects: ['proj-a', 'proj-b'] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.projects).toEqual(['proj-a', 'proj-b']);
  });

  test('rejects ["*", "proj-a"] — wildcard cannot mix with explicit ids', () => {
    const r = agentFrontmatterSchema.safeParse({ ...base, projects: ['*', 'proj-a'] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toMatch(/cannot be combined/i);
    }
  });

  test('accepts an empty array (explicitly no projects)', () => {
    const r = agentFrontmatterSchema.safeParse({ ...base, projects: [] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.projects).toEqual([]);
  });
});

describe('toolsToScopes', () => {
  test('list/get tools require documents:read', () => {
    expect(toolsToScopes(['list_documents'])).toContain('documents:read');
    expect(toolsToScopes(['get_document', 'get_document_markdown'])).toContain('documents:read');
  });

  test('create/update tools require documents:write', () => {
    expect(toolsToScopes(['create_document'])).toContain('documents:write');
    expect(toolsToScopes(['update_document'])).toContain('documents:write');
  });

  test('delete_document requires documents:delete', () => {
    expect(toolsToScopes(['delete_document'])).toContain('documents:delete');
  });

  test('write tools always also include read', () => {
    expect(toolsToScopes(['create_document'])).toContain('documents:read');
  });

  test('empty tools returns no scopes', () => {
    expect(toolsToScopes([])).toEqual([]);
  });

  test('scopes are deduped', () => {
    const out = toolsToScopes(['list_documents', 'get_document', 'create_document', 'update_document']);
    const reads = out.filter((s) => s === 'documents:read');
    expect(reads.length).toBe(1);
  });

  // Phase 2.6 sub-phase D — agent lifecycle tools.
  test('maps create_agent / update_agent / delete_agent to agents:write', () => {
    expect(toolsToScopes(['create_agent'])).toContain('agents:write');
    expect(toolsToScopes(['update_agent'])).toContain('agents:write');
    expect(toolsToScopes(['delete_agent'])).toContain('agents:write');
  });

  test('maps get_agent_self to documents:read only (read-only metadata)', () => {
    const scopes = toolsToScopes(['get_agent_self']);
    expect(scopes).toContain('documents:read');
    expect(scopes).not.toContain('agents:write');
  });

  test('agent-write tools also include documents:read', () => {
    expect(toolsToScopes(['create_agent'])).toContain('documents:read');
  });
});

describe('claude-code agent frontmatter', () => {
  test('accepts provider=claude-code with NO model', () => {
    const parsed = agentFrontmatterSchema.parse({ provider: 'claude-code', tools: [], projects: ['*'] });
    expect(parsed.provider).toBe('claude-code');
    expect(parsed.model).toBeUndefined();
  });
  test('still requires model for an API provider', () => {
    expect(() => agentFrontmatterSchema.parse({ provider: 'anthropic', tools: [], projects: ['*'] })).toThrow();
  });
  test('PATCH path (.innerType().partial()) still parses a partial agent frontmatter', () => {
    // proves the documents.ts:806 consumer fix works after the schema became ZodEffects
    const schema = agentFrontmatterSchema.innerType().partial();
    const r = schema.safeParse({ requires_approval: true });
    expect(r.success).toBe(true);
  });
});

describe('V1_MCP_TOOLS', () => {
  test('contains the v1 tools including agent-lifecycle tools', () => {
    expect(V1_MCP_TOOLS).toEqual([
      'list_workspaces', 'list_projects', 'list_documents',
      'get_document', 'get_document_markdown',
      'create_document', 'update_document', 'delete_document',
      'list_statuses', 'list_fields', 'list_views',
      'run_view',
      // Phase 2.6 sub-phase D — agent lifecycle tools.
      'create_agent', 'update_agent', 'delete_agent', 'get_agent_self',
      // search_documents deferred to v1.1
    ] as const);
  });
});
