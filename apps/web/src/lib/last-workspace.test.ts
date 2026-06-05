import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLastWorkspaceSlug, setLastWorkspaceSlug } from './last-workspace.ts';

describe('last-workspace store', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('returns null when nothing stored', () => {
    expect(getLastWorkspaceSlug()).toBeNull();
  });

  it('round-trips a slug', () => {
    setLastWorkspaceSlug('acme');
    expect(getLastWorkspaceSlug()).toBe('acme');
  });

  it('overwrites the previous slug', () => {
    setLastWorkspaceSlug('acme');
    setLastWorkspaceSlug('beta');
    expect(getLastWorkspaceSlug()).toBe('beta');
  });
});
