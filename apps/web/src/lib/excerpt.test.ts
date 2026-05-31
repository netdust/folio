import { describe, expect, test } from 'vitest';
import { bodyExcerpt } from './excerpt.ts';

describe('bodyExcerpt', () => {
  test('strips a leading H1 and returns the first prose line', () => {
    expect(bodyExcerpt('# Title\n\nFirst real line here.\n\nmore')).toBe('First real line here.');
  });
  test('strips common markdown markers', () => {
    expect(bodyExcerpt('- **bold** item')).toBe('bold item');
  });
  test('truncates to maxLen with an ellipsis', () => {
    expect(bodyExcerpt('a'.repeat(200), 20)).toBe(`${'a'.repeat(20)}…`);
  });
  test('empty / whitespace body returns empty string', () => {
    expect(bodyExcerpt('   \n\n')).toBe('');
  });
});
