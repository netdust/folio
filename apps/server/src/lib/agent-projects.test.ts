/**
 * Tests for the agent-projects helpers: the canonical allow-list resolver,
 * the token-narrowing intersect, and the caller→project-set mapping used by
 * caller-identity delegation (D5/D9).
 */
import { expect, test } from 'bun:test';
import { callerProjectsFor } from './agent-projects.ts';

test('callerProjectsFor: workspace owner maps to wildcard (null = all projects)', () => {
  expect(callerProjectsFor({ role: 'owner', projectIds: ['p1'] })).toBeNull();
});
test('callerProjectsFor: admin is clamped to their explicit project list, NOT wildcard (CR-1)', () => {
  // Post-tenancy, ONLY owner bypasses grants. An admin holding only a
  // project_access grant must not borrow reach to sibling projects, so it
  // clamps to its explicit visible list exactly like a member.
  expect(callerProjectsFor({ role: 'admin', projectIds: ['p1'] })).toEqual(['p1']);
  expect(callerProjectsFor({ role: 'admin', projectIds: [] })).toEqual([]);
});
test('callerProjectsFor: regular member maps to their explicit membership, never wildcard', () => {
  expect(callerProjectsFor({ role: 'member', projectIds: ['p1', 'p2'] })).toEqual(['p1', 'p2']);
});
test('callerProjectsFor: member with no project memberships maps to [] (deny), not null', () => {
  expect(callerProjectsFor({ role: 'member', projectIds: [] })).toEqual([]);
});
