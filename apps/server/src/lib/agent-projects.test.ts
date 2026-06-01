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
test('callerProjectsFor: admin maps to wildcard (null), regardless of project list', () => {
  expect(callerProjectsFor({ role: 'admin', projectIds: [] })).toBeNull();
});
test('callerProjectsFor: regular member maps to their explicit membership, never wildcard', () => {
  expect(callerProjectsFor({ role: 'member', projectIds: ['p1', 'p2'] })).toEqual(['p1', 'p2']);
});
test('callerProjectsFor: member with no project memberships maps to [] (deny), not null', () => {
  expect(callerProjectsFor({ role: 'member', projectIds: [] })).toEqual([]);
});
