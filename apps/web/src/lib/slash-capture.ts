/**
 * Position-capture for the ASYNC slash commands (`/draft`, `/summarize`,
 * `/decompose`) in the body editor.
 *
 * The synchronous `/link` command reads the live `window.getSelection()` at
 * apply time and that is correct — there's no gap. But the AI commands await
 * the provider for SECONDS, during which the user can move the caret, type, or
 * delete the `/draft` token. If the result were placed via a fresh live-
 * selection lookup it would land at the moved caret, replace the wrong text, or
 * silently no-op when `lastIndexOf('/')` returns -1 (findings 210/201/211/171).
 *
 * So we snapshot the slash-token's span (the text node + the offsets of the
 * `/` and the caret) BEFORE the await, and replace THAT captured span on
 * resolve — re-validating the node is still connected first.
 */

export interface CapturedSlashToken {
  node: Text;
  /** Offset of the `/` that opened the token (or the caret, if none found). */
  slashStart: number;
  /** Offset of the caret at capture time — the end of the token. */
  tokenEnd: number;
}

/**
 * Snapshot the slash-token span at the current selection. Mirrors the live
 * `insert()` lookup: the token ends at the caret and begins at the last `/`
 * before it. When no `/` precedes the caret we still capture the caret position
 * (slashStart === tokenEnd) so the AI result lands where the command was
 * invoked. Returns `null` when there is no usable text-node selection.
 */
export function captureSlashToken(sel: Selection | null): CapturedSlashToken | null {
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const txt = (node as Text).data;
  const at = txt.lastIndexOf('/', range.startOffset - 1);
  return {
    node: node as Text,
    slashStart: at >= 0 ? at : range.startOffset,
    tokenEnd: range.startOffset,
  };
}

/**
 * Replace the captured slash-token span with `text` (an empty string deletes
 * the token — used on error to clear the orphaned `/draft`, finding 213).
 *
 * Re-validates the captured node is still connected — if the user deleted that
 * whole block the node is detached and we can't safely place anything; returns
 * `false` so the caller can warn instead of silently dropping the result.
 * Offsets are clamped to the node's CURRENT length (the user may have edited
 * around the token without detaching it).
 */
export function applyAtCapturedRange(
  captured: CapturedSlashToken | null,
  text: string,
): boolean {
  if (!captured) return false;
  const { node, slashStart, tokenEnd } = captured;
  if (!node.isConnected) return false;
  const len = node.data.length;
  const start = Math.min(slashStart, len);
  const end = Math.min(tokenEnd, len);
  const replaceRange = document.createRange();
  replaceRange.setStart(node, start);
  replaceRange.setEnd(node, end);
  replaceRange.deleteContents();
  if (text.length > 0) node.insertData(start, text);
  return true;
}
