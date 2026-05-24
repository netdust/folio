import { describe, it, expect } from 'vitest';
import { matches } from './command-registry.ts';

describe('matches', () => {
  it('returns true for empty query', () => {
    expect(matches({ label: 'anything' }, '')).toBe(true);
    expect(matches({ label: 'anything' }, '   ')).toBe(true);
  });

  it('case-insensitive substring match', () => {
    expect(matches({ label: 'Switch workspace' }, 'switch')).toBe(true);
    expect(matches({ label: 'Switch workspace' }, 'WORK')).toBe(true);
    expect(matches({ label: 'Switch workspace' }, 'zzz')).toBe(false);
  });
});
