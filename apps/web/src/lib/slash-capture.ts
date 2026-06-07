/**
 * Position-capture + parser-insert for the ASYNC slash commands (`/draft`,
 * `/summarize`, `/decompose`) in the body editor.
 *
 * Two problems compose here:
 *
 * 1. PARSING. The AI returns multi-block markdown (`# Title\n\n- a\n- b`). The
 *    user is in the RENDERED (WYSIWYG) Milkdown editor, so that string must be
 *    PARSED into ProseMirror nodes (H1, paragraph, list) — not poked into a
 *    single text node as literal characters. The old DOM `insertData` path
 *    bypassed the parser, so `#` stayed literal and `\n` collapsed. The fix
 *    routes the insert through the Editor instance's `replaceRange` action
 *    (from `@milkdown/utils`), which parses the markdown via `parserCtx` and
 *    replaces a ProseMirror position range in one transaction.
 *
 * 2. ASYNC CARET MOVE. The AI await lasts SECONDS, during which the user can
 *    move the caret, type, or delete the `/draft` token. If the result were
 *    placed at a fresh live selection it would land at the moved caret, replace
 *    the wrong text, or silently no-op (findings 210/201/211/171). So we
 *    snapshot the slash-token's ProseMirror position range BEFORE the await and
 *    replace THAT captured range on resolve — re-validating the range is still
 *    inside the (possibly edited) document first.
 *
 * Working through ProseMirror POSITIONS (not DOM Ranges) is what makes the
 * parser-insert robust: `replaceRange(markdown, {from, to})` both parses and
 * targets an explicit, mappable position range.
 */

/** A ProseMirror position range snapshot of the slash token. */
export interface SlashTokenRange {
  /** PM position of the `/` that opened the token (or the caret, if none). */
  from: number;
  /** PM position of the caret at capture time — the end of the token. */
  to: number;
}

/**
 * The minimal slice of a ProseMirror `EditorView` / `EditorState` this module
 * reads. Declared narrowly so the capture/validate logic is unit-testable
 * without constructing a full Milkdown editor (jsdom can't render one).
 */
export interface SlashTokenView {
  state: {
    selection: { from: number };
    doc: {
      content: { size: number };
      /** Resolve a position into a `$pos` with parent-offset context. */
      resolve(pos: number): {
        parentOffset: number;
        parent: {
          /** Text content of the parent textblock between two offsets. */
          textBetween(from: number, to: number): string;
          /** Whether the parent node is a textblock (paragraph/heading/etc). */
          isTextblock: boolean;
        };
      };
    };
  };
}

/**
 * The minimal slice of a Milkdown `Editor` this module needs to run an action.
 * `editor.action(fn)` invokes `fn(ctx)` — `@milkdown/utils` macros are exactly
 * such `(ctx) => void` functions, so a captured `replaceRange(...)` macro is
 * passed straight through.
 */
export interface SlashEditor {
  action(fn: unknown): unknown;
}

/**
 * Builds the editor ACTION that parses `markdown` and places it over the
 * `{from, to}` range. Modelled on `@milkdown/utils`'s `replaceRange`, but the
 * body editor passes a variant that inserts the parsed content as a CLOSED
 * slice (whole blocks) so a leading `# Heading` lands as a real H1 instead of
 * being flattened into the host paragraph the `/draft` token lived in. The
 * returned value is a `(ctx) => void` macro handed straight to `editor.action`.
 */
export type ParseInsertFactory = (
  markdown: string,
  range: { from: number; to: number },
) => unknown;

/**
 * Snapshot the slash-token's ProseMirror position range at the current
 * selection. The token ends at the caret and begins at the last `/` before it
 * within the same textblock. When no `/` precedes the caret in this textblock
 * we capture the caret position (from === to) so the AI result lands where the
 * command was invoked. Returns `null` when there is no usable textblock
 * selection.
 */
export function captureSlashTokenRange(view: SlashTokenView | null): SlashTokenRange | null {
  if (!view) return null;
  const { selection, doc } = view.state;
  const caret = selection.from;
  if (caret < 0 || caret > doc.content.size) return null;
  const $caret = doc.resolve(caret);
  if (!$caret.parent.isTextblock) return null;
  const parentOffset = $caret.parentOffset;
  const before = $caret.parent.textBetween(0, parentOffset);
  const slashIdx = before.lastIndexOf('/');
  // `/` PM position = caret − (chars between the `/` and the caret). When no `/`
  // is found, slashIdx is -1 → from === to === caret (insert at caret).
  const from = slashIdx >= 0 ? caret - (parentOffset - slashIdx) : caret;
  return { from, to: caret };
}

/**
 * Replace the captured slash-token range with `markdown`, PARSED through the
 * editor (an empty string deletes the token — used on error to clear the
 * orphaned `/draft`, finding 213).
 *
 * Routes through `editor.action(parseInsert(markdown, range))`: the macro
 * parses the markdown via the editor's `parserCtx` and replaces the position
 * range, so `#`/lists/paragraphs render as real ProseMirror nodes rather than
 * literal text (the root-cause fix).
 *
 * Re-validates the captured range is still inside the (possibly edited)
 * document before applying — if the user deleted the block the range now
 * exceeds `doc.content.size` and we can't safely place anything; returns
 * `false` so the caller can warn instead of silently dropping the result.
 */
export function replaceCapturedRange(
  editor: SlashEditor | null,
  view: SlashTokenView | null,
  captured: SlashTokenRange | null,
  markdown: string,
  parseInsert: ParseInsertFactory,
): boolean {
  if (!editor || !view || !captured) return false;
  const docSize = view.state.doc.content.size;
  const { from, to } = captured;
  // The captured range must still be a valid, ordered span inside the document.
  // After a deletion the doc can shrink below `to` (or below `from`); bail and
  // let the caller warn rather than throw inside the transaction.
  if (from < 0 || to < from || to > docSize) return false;
  editor.action(parseInsert(markdown, { from, to }));
  return true;
}
