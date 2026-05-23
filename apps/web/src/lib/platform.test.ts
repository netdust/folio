import { afterEach, describe, expect, it, vi } from 'vitest';
import { modKeyGlyph, modKeyHint } from './platform.ts';

function withPlatform<T>(platform: string, fn: () => T): T {
  const spy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe('platform', () => {
  afterEach(() => vi.restoreAllMocks());

  it('modKeyGlyph returns ⌘ on Mac platforms', () => {
    expect(withPlatform('MacIntel', () => modKeyGlyph())).toBe('⌘');
  });

  it('modKeyGlyph returns Ctrl on Linux', () => {
    expect(withPlatform('Linux x86_64', () => modKeyGlyph())).toBe('Ctrl');
  });

  it('modKeyGlyph returns Ctrl on Windows', () => {
    expect(withPlatform('Win32', () => modKeyGlyph())).toBe('Ctrl');
  });

  it('modKeyHint composes the glyph with a suffix', () => {
    expect(withPlatform('Linux x86_64', () => modKeyHint('K'))).toBe('CtrlK');
  });
});
