import { test, expect } from 'bun:test';
import { slugify } from './slug.ts';

test('lowercases and replaces spaces with hyphens', () => {
  expect(slugify('Hello World')).toBe('hello-world');
});

test('strips diacritics', () => {
  expect(slugify('Café déjà-vu')).toBe('cafe-deja-vu');
});

test('collapses non-alphanumeric runs', () => {
  expect(slugify('foo!!  bar??')).toBe('foo-bar');
});

test('trims leading/trailing hyphens', () => {
  expect(slugify('---foo---')).toBe('foo');
});

test('caps at 64 chars', () => {
  expect(slugify('a'.repeat(100)).length).toBe(64);
});

test('empty input returns empty string', () => {
  expect(slugify('')).toBe('');
});
