/**
 * Platform-aware modifier key glyph. Used for kbd hints in the UI so users on
 * non-Mac platforms see `Ctrl` instead of the macOS `⌘`. Matches the
 * shortcut detection in `components/command-palette.tsx`.
 */
export function modKeyGlyph(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
}

/** `${mod}${suffix}` — e.g. `⌘K` on Mac, `CtrlK` elsewhere. */
export function modKeyHint(suffix: string): string {
  return `${modKeyGlyph()}${suffix}`;
}

/** Alt/Option key glyph — `⌥` on Mac, `Alt` elsewhere. */
export function altKeyGlyph(): string {
  if (typeof navigator === 'undefined') return 'Alt';
  return navigator.platform.toLowerCase().includes('mac') ? '⌥' : 'Alt';
}

/** `${alt}${suffix}` — e.g. `⌥M` on Mac, `AltM` elsewhere. */
export function altKeyHint(suffix: string): string {
  return `${altKeyGlyph()}${suffix}`;
}
