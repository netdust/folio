import { describe, expect, test } from 'bun:test';
import { SYSTEM_WORKSPACE_SLUG, isReservedSlug } from './system-workspace.ts';

describe('reserved slug (M2/M3)', () => {
  test('the system workspace slug is the reserved underscore-prefixed constant', () => {
    expect(SYSTEM_WORKSPACE_SLUG).toBe('__system');
    expect(isReservedSlug(SYSTEM_WORKSPACE_SLUG)).toBe(true);
  });
  test('any underscore-prefixed slug is reserved', () => {
    expect(isReservedSlug('__anything')).toBe(true);
    expect(isReservedSlug('_x')).toBe(true);
  });
  test('normal slugs are not reserved', () => {
    expect(isReservedSlug('acme')).toBe(false);
    expect(isReservedSlug('web-2')).toBe(false);
    expect(isReservedSlug('')).toBe(false);
  });
});
