import { describe, it, expect } from 'vitest';
import { matchWikiTrigger, replaceWikiToken } from './wiki-trigger.ts';

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

  it('does not let an unclosed [[ match across a newline', () => {
    // The `[[` opener is on the first line; the caret text ends on the second
    // line as prose. The trigger must NOT survive the newline — there is no
    // `[[` on the line the caret is on, so this returns null (picker closes).
    expect(matchWikiTrigger('[[foo\nbar')).toBeNull();
    expect(matchWikiTrigger('[[foo\r\nbar')).toBeNull();
  });
});

describe('replaceWikiToken', () => {
  it('replaces the [[<query> token with [[slug]] (no trailing brackets)', () => {
    const r = replaceWikiToken('see [[fo', 8, 'foo');
    expect(r).toEqual({ start: 4, end: 8, newText: 'see [[foo]]' });
  });

  it('consumes an orphaned trailing ]] instead of doubling it', () => {
    // Caret sits after `fo`, between the brackets: 'see [[fo]]' caret at 8.
    const r = replaceWikiToken('see [[fo]]', 8, 'foo');
    expect(r).not.toBeNull();
    expect(r?.newText).toBe('see [[foo]]');
    expect(r?.newText).not.toBe('see [[foo]]]]');
  });

  it('replaces a bare [[ at the caret', () => {
    const r = replaceWikiToken('[[', 2, 'bar');
    expect(r).toEqual({ start: 0, end: 2, newText: '[[bar]]' });
  });

  it('preserves text after the replaced range', () => {
    // 'a [[q and more' — opener `[[` at index 2, caret at 5 (right after `q`).
    const r = replaceWikiToken('a [[q and more', 5, 'slug');
    expect(r?.newText).toBe('a [[slug]] and more');
  });

  it('returns null when there is no [[ opener at or before the caret', () => {
    expect(replaceWikiToken('no bracket', 5, 'x')).toBeNull();
  });
});
