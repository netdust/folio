/**
 * Detect an active `[[` wiki-link trigger at the end of the text before the
 * caret. Mirrors the `/` slash trigger in `body-editor.tsx`, but for the
 * Obsidian-style `[[<slug>]]` affordance.
 *
 * Returns the in-progress query (possibly an empty string) when `beforeText`
 * ends with an unclosed `[[` followed by an optional query, else `null`.
 *
 * The query may contain any chars EXCEPT a closing `]` or a line break, so an
 * already-closed link (`[[done]]`) does not re-trigger and an unclosed `[[`
 * does not keep matching across a newline into prose on the next line.
 *
 *   'see [['          → ''
 *   'see [[foo'        → 'foo'
 *   'see [[foo bar'    → 'foo bar'
 *   'no bracket'       → null
 *   '[[done]]'         → null
 *   '[[done]] and [[ne'→ 'ne'
 *   '[[foo\nbar'       → null   (the `[[` does not survive the newline)
 */
export function matchWikiTrigger(beforeText: string): string | null {
  const m = beforeText.match(/\[\[([^\]\r\n]*)$/);
  return m ? (m[1] ?? '') : null;
}

/**
 * Pure token-replacement for inserting a `[[slug]]` wiki-link. Given a single
 * text node's content, the caret offset within it, and a slug, computes the
 * range that should be replaced and the new text.
 *
 * The opener is the last `[[` at or before the caret. The replaced range runs
 * from that opener to the caret — and, crucially, also consumes an orphaned
 * trailing `]]` immediately after the caret if one exists, so we never produce
 * `[[slug]]]]` (e.g. when an auto-pair or the user left a `[[]]` and typed the
 * query inside it).
 *
 * Returns `null` when there is no `[[` opener at/before the caret (caller
 * should no-op, matching the previous DOM behavior).
 *
 *   replaceWikiToken('see [[fo', 8, 'foo')   → start 4, end 8,  'see [[foo]]'
 *   replaceWikiToken('see [[fo]]', 8, 'foo') → start 4, end 10, 'see [[foo]]'  (no doubling)
 */
export function replaceWikiToken(
  text: string,
  caretOffset: number,
  slug: string,
): { start: number; end: number; newText: string } | null {
  const start = text.lastIndexOf('[[', caretOffset - 1);
  if (start < 0) return null;
  // Consume an orphaned trailing `]]` immediately after the caret so the
  // inserted `[[slug]]` replaces both the `[[<query>` token and the stray `]]`.
  let end = caretOffset;
  if (text.slice(caretOffset, caretOffset + 2) === ']]') {
    end = caretOffset + 2;
  }
  const newText = text.slice(0, start) + `[[${slug}]]` + text.slice(end);
  return { start, end, newText };
}
