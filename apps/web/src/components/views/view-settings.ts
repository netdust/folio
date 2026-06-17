/**
 * Shared helpers for reading a view's `settings` JSON. The settings object is
 * untyped (a `Record<string, unknown>` round-tripped from the DB), so callers
 * narrow each field on read with a fallback. Hoisted here so ViewControls and
 * the per-type view components share ONE narrowing implementation.
 */

/** Narrow an unknown settings value to a non-empty string, else fall back. */
export function settingString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}
