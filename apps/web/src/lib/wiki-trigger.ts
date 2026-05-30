/**
 * Detect an active `[[` wiki-link trigger at the end of the text before the
 * caret. Mirrors the `/` slash trigger in `body-editor.tsx`, but for the
 * Obsidian-style `[[<slug>]]` affordance.
 *
 * Returns the in-progress query (possibly an empty string) when `beforeText`
 * ends with an unclosed `[[` followed by an optional query, else `null`.
 *
 * The query may contain word chars, spaces, and hyphens — but NOT a closing
 * `]`, so an already-closed link (`[[done]]`) does not re-trigger.
 *
 *   'see [['          → ''
 *   'see [[foo'        → 'foo'
 *   'see [[foo bar'    → 'foo bar'
 *   'no bracket'       → null
 *   '[[done]]'         → null
 *   '[[done]] and [[ne'→ 'ne'
 */
export function matchWikiTrigger(beforeText: string): string | null {
  const m = beforeText.match(/\[\[([\w\s-]*)$/);
  return m ? (m[1] ?? '') : null;
}
