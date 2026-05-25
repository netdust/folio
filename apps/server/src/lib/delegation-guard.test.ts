import { test, expect } from 'bun:test';
import { walkParentChain, type AgentLookup } from './delegation-guard.ts';

const make = (lookups: Record<string, { parent: string | null; max_delegation_depth: number }>): AgentLookup => ({
  findAgentBySlug: async (slug) => lookups[slug] ?? null,
});

test('walkParentChain returns depth 0 for a top-level agent', async () => {
  const lookup = make({ a: { parent: null, max_delegation_depth: 2 } });
  expect(await walkParentChain('a', lookup)).toBe(0);
});

test('walkParentChain returns depth 1 for a single-parent chain', async () => {
  const lookup = make({
    parent: { parent: null, max_delegation_depth: 2 },
    child: { parent: 'parent', max_delegation_depth: 2 },
  });
  expect(await walkParentChain('child', lookup)).toBe(1);
});

test('walkParentChain detects cycles and throws', async () => {
  const lookup = make({
    a: { parent: 'b', max_delegation_depth: 2 },
    b: { parent: 'a', max_delegation_depth: 2 },
  });
  await expect(walkParentChain('a', lookup)).rejects.toThrow(/cycle/i);
});

test('walkParentChain caps depth at 10 and throws if exceeded', async () => {
  const lookup = make(Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `a${i}`, { parent: i > 0 ? `a${i - 1}` : null, max_delegation_depth: 5 },
    ]),
  ));
  await expect(walkParentChain('a11', lookup)).rejects.toThrow(/too deep/i);
});
