import { test, expect } from 'bun:test';
import { inferFieldType } from './field-infer.ts';

test('boolean true', () => { expect(inferFieldType(true)).toBe('boolean'); });
test('boolean false', () => { expect(inferFieldType(false)).toBe('boolean'); });

test('datetime ISO', () => {
  expect(inferFieldType('2026-05-11T14:30:00Z')).toBe('datetime');
  expect(inferFieldType('2026-05-11T14:30:00+02:00')).toBe('datetime');
});

test('date ISO', () => { expect(inferFieldType('2026-05-11')).toBe('date'); });

test('number', () => {
  expect(inferFieldType(42)).toBe('number');
  expect(inferFieldType(3.14)).toBe('number');
});

test('multi_select for string array', () => {
  expect(inferFieldType(['a', 'b'])).toBe('multi_select');
});

test('user_ref needs context match', () => {
  const ctx = { knownEmails: new Set(['x@y.com']) };
  expect(inferFieldType('x@y.com', ctx)).toBe('user_ref');
});

test('email without context falls through to string', () => {
  expect(inferFieldType('x@y.com')).toBe('string');
});

test('url http/https/mailto', () => {
  expect(inferFieldType('https://example.com')).toBe('url');
  expect(inferFieldType('mailto:x@y.com')).toBe('url');
});

test('document_ref wiki-link syntax', () => {
  expect(inferFieldType('[[some-doc]]')).toBe('document_ref');
});

test('text for multi-line string', () => {
  expect(inferFieldType('line one\nline two')).toBe('text');
});

test('string fallback', () => {
  expect(inferFieldType('plain')).toBe('string');
});

test('order: boolean wins over number for false', () => {
  expect(inferFieldType(false)).toBe('boolean');
});

test('order: datetime beats date when both could match', () => {
  expect(inferFieldType('2026-05-11T00:00:00Z')).toBe('datetime');
});
