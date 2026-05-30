import { describe, it, expect } from 'vitest';
import { matchWikiTrigger } from './wiki-trigger.ts';

describe('matchWikiTrigger', () => {
  it('returns empty string when text ends with bare [[', () => {
    expect(matchWikiTrigger('see [[')).toBe('');
  });

  it('returns the query when text ends with [[<query>', () => {
    expect(matchWikiTrigger('see [[foo')).toBe('foo');
  });

  it('allows spaces in the query', () => {
    expect(matchWikiTrigger('see [[foo bar')).toBe('foo bar');
  });

  it('matches at the very start of the text', () => {
    expect(matchWikiTrigger('[[')).toBe('');
    expect(matchWikiTrigger('[[abc')).toBe('abc');
  });

  it('returns null when there is no open bracket', () => {
    expect(matchWikiTrigger('no bracket')).toBeNull();
  });

  it('returns null when the link is already closed', () => {
    expect(matchWikiTrigger('[[done]]')).toBeNull();
  });

  it('returns null for a single open bracket', () => {
    expect(matchWikiTrigger('see [')).toBeNull();
  });

  it('returns null when the query crosses a closing bracket', () => {
    // a closed link earlier, then plain text after — not an active trigger
    expect(matchWikiTrigger('[[done]] more text')).toBeNull();
  });

  it('matches the most recent open bracket after a closed link', () => {
    expect(matchWikiTrigger('[[done]] and [[ne')).toBe('ne');
  });
});
