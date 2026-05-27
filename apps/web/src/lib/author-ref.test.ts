import { describe, it, expect } from 'vitest';
import {
  authorAgentSlug,
  authorDisplayName,
  authorMatchesCurrent,
  parseAuthorRef,
} from './author-ref.ts';

const AGENT = { id: 'ag-uuid-1', slug: 'drafter' };
const MEMBER = { id: 'u-uuid-1', name: 'Stefan' };

describe('parseAuthorRef', () => {
  it('parses user:<id>', () => {
    expect(parseAuthorRef('user:u-1')).toEqual({ kind: 'user', value: 'u-1' });
  });
  it('parses agent:<id>', () => {
    expect(parseAuthorRef('agent:ag-1')).toEqual({ kind: 'agent', value: 'ag-1' });
  });
  it('returns null for malformed prefix', () => {
    expect(parseAuthorRef('something-else')).toBeNull();
    expect(parseAuthorRef('agent:')).toBeNull();
    expect(parseAuthorRef('robot:foo')).toBeNull();
  });
});

describe('authorDisplayName', () => {
  it('resolves agent:<id> to agent.slug', () => {
    expect(authorDisplayName('agent:ag-uuid-1', [AGENT], [MEMBER])).toBe('drafter');
  });
  it('resolves user:<id> to member.name', () => {
    expect(authorDisplayName('user:u-uuid-1', [AGENT], [MEMBER])).toBe('Stefan');
  });
  it('resolves legacy agent:<slug> to agent.slug (back-compat)', () => {
    expect(authorDisplayName('agent:drafter', [AGENT], [MEMBER])).toBe('drafter');
  });
  it('falls back to the raw value when the agent is gone', () => {
    expect(authorDisplayName('agent:ghost', [AGENT], [MEMBER])).toBe('ghost');
  });
  it('falls back to the raw value when the member is gone', () => {
    expect(authorDisplayName('user:u-gone', [AGENT], [MEMBER])).toBe('u-gone');
  });
  it('returns the input unchanged when prefix is unrecognized', () => {
    expect(authorDisplayName('weird:foo', [AGENT], [MEMBER])).toBe('weird:foo');
  });
});

describe('authorAgentSlug', () => {
  it('returns the slug for an agent:<id> author', () => {
    expect(authorAgentSlug('agent:ag-uuid-1', [AGENT])).toBe('drafter');
  });
  it('returns the slug for a legacy agent:<slug> author (back-compat)', () => {
    expect(authorAgentSlug('agent:drafter', [AGENT])).toBe('drafter');
  });
  it('returns null for a user author', () => {
    expect(authorAgentSlug('user:u-1', [AGENT])).toBeNull();
  });
  it('falls back to the raw suffix when the agent is gone but suffix looks like a slug', () => {
    expect(authorAgentSlug('agent:ghost', [AGENT])).toBe('ghost');
  });
  it('returns null when the suffix looks like a uuid (no agent match + not slug-shaped)', () => {
    expect(authorAgentSlug('agent:Vh5KqzAbCd_-XYZ', [AGENT])).toBeNull();
  });
});

describe('authorMatchesCurrent', () => {
  it('matches user-author against current userId', () => {
    expect(authorMatchesCurrent('user:u-1', 'u-1', null)).toBe(true);
    expect(authorMatchesCurrent('user:u-2', 'u-1', null)).toBe(false);
  });
  it('matches id-canonical agent-author against current agent id', () => {
    expect(authorMatchesCurrent('agent:ag-uuid-1', null, AGENT)).toBe(true);
  });
  it('matches legacy slug-form agent-author against current agent slug (back-compat)', () => {
    expect(authorMatchesCurrent('agent:drafter', null, AGENT)).toBe(true);
  });
  it('returns false when the agent author identifies a different agent', () => {
    expect(authorMatchesCurrent('agent:other-slug', null, AGENT)).toBe(false);
  });
  it('returns false for an agent author when no current agent is set', () => {
    expect(authorMatchesCurrent('agent:ag-uuid-1', null, null)).toBe(false);
  });
});
