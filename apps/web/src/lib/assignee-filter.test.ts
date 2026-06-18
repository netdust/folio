import { describe, expect, it } from 'vitest';
import { filterAgents, filterMembers } from './assignee-filter.ts';

const members = [
  { name: 'Alice', email: 'alice@test' },
  { name: 'Bob', email: 'bob@example.com' },
];
const agents = [
  { title: 'Triage Bot', slug: 'triage-bot' },
  { title: 'Summarizer', slug: 'summarize' },
];

describe('assignee-filter', () => {
  it('empty query returns all members and all agents (match-all)', () => {
    expect(filterMembers(members, '')).toHaveLength(2);
    expect(filterAgents(agents, '')).toHaveLength(2);
  });

  it('whitespace-only query is treated as match-all', () => {
    expect(filterMembers(members, '   ')).toHaveLength(2);
  });

  it('matches member by name, case-insensitive', () => {
    expect(filterMembers(members, 'ali')).toEqual([members[0]]);
    expect(filterMembers(members, 'ALICE')).toEqual([members[0]]);
  });

  it('matches member by email substring (domain)', () => {
    expect(filterMembers(members, '@example')).toEqual([members[1]]);
  });

  it('matches agent by title and by slug, case-insensitive', () => {
    expect(filterAgents(agents, 'triage')).toEqual([agents[0]]);
    expect(filterAgents(agents, 'SUMMAR')).toEqual([agents[1]]);
    expect(filterAgents(agents, 'summarize')).toEqual([agents[1]]); // slug match
  });

  it('no-match query returns empty array', () => {
    expect(filterMembers(members, 'zzz')).toEqual([]);
    expect(filterAgents(agents, 'zzz')).toEqual([]);
  });
});
