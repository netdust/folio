export interface AgentLookup {
  findAgentBySlug(slug: string): Promise<{ parent: string | null; max_delegation_depth: number } | null>;
}

const MAX_WALK = 10;

/** Walk the parent_agent chain from `slug` up. Returns the depth (0 = root).
 *  Throws on cycle or chain > MAX_WALK hops. */
export async function walkParentChain(slug: string, lookup: AgentLookup): Promise<number> {
  const visited = new Set<string>();
  let current: string | null = slug;
  let depth = 0;
  while (current) {
    if (visited.has(current)) throw new Error('agent delegation cycle detected');
    visited.add(current);
    if (depth > MAX_WALK) throw new Error('agent delegation chain too deep');
    const row: { parent: string | null; max_delegation_depth: number } | null = await lookup.findAgentBySlug(current);
    if (!row) return depth;
    current = row.parent;
    if (current) depth++;
  }
  return depth;
}
