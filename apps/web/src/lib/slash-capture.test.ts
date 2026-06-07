import { describe, it, expect, vi } from 'vitest';
import {
  captureSlashTokenRange,
  replaceCapturedRange,
  type SlashTokenView,
  type SlashEditor,
} from './slash-capture.ts';

/**
 * These tests exercise the root-cause fix for the ASYNC slash commands:
 *
 * 1. PARSE, don't poke: the AI markdown must be routed through the editor's
 *    `replaceRange` action (which parses via `parserCtx`) — NOT a raw DOM
 *    `insertData` (which leaves `#` literal and collapses `\n`). The bite that
 *    distinguishes the fix from the bug is `editor.action(replaceRange(md, …))`
 *    being invoked with the markdown.
 *
 * 2. Position-capture (findings 210/201/211/171): the slash token's ProseMirror
 *    {from, to} range is snapshotted BEFORE the multi-second AI await, and the
 *    result is placed at THAT captured range — even after the live caret moved.
 *
 * jsdom cannot render a real Milkdown/ProseMirror tree, so we drive the logic
 * against a minimal fake view (the `SlashTokenView` shape the module reads) and
 * a spy `editor.action`. The faithful "literal `#` becomes a real `<h1>`" proof
 * is a real-browser drive (Playwright/Chrome shake-out), noted as a deferral.
 */

/**
 * Build a fake ProseMirror-view shape with a single textblock containing
 * `text`, with the caret at `caret` (offset within the textblock, 1-based PM
 * position: PM pos 1 is the first char of the first textblock).
 */
function fakeView(text: string, caret: number): SlashTokenView {
  // PM positions: pos 0 is before the doc, pos 1 is the start of the first
  // textblock's text. doc.content.size = text.length + 2 (open+close of the
  // single textblock). We model resolve() to expose parentOffset + textBetween.
  const docSize = text.length + 2;
  return {
    state: {
      selection: { from: caret },
      doc: {
        content: { size: docSize },
        resolve(pos: number) {
          const parentOffset = Math.max(0, Math.min(pos - 1, text.length));
          return {
            parentOffset,
            parent: {
              isTextblock: true,
              textBetween(from: number, to: number) {
                return text.slice(from, to);
              },
            },
          };
        },
      },
    },
  };
}

describe('captureSlashTokenRange', () => {
  it('captures the slash-token range at the caret (the `/` through the caret)', () => {
    // "write /draft" — caret after "/draft". PM: "write /draft" starts at pos 1,
    // so the caret (offset 12 in the text) is PM pos 13, and the `/` (text index
    // 6) is PM pos 7.
    const view = fakeView('write /draft', 13);
    const cap = captureSlashTokenRange(view);
    expect(cap).not.toBeNull();
    expect(cap?.from).toBe(7); // PM pos of "/"
    expect(cap?.to).toBe(13); // PM pos of the caret
  });

  it('captures the caret position when there is no `/` token (from === to)', () => {
    const view = fakeView('plain text', 11); // caret at end, PM pos 11
    const cap = captureSlashTokenRange(view);
    expect(cap?.from).toBe(11);
    expect(cap?.to).toBe(11);
  });

  it('returns null when there is no view', () => {
    expect(captureSlashTokenRange(null)).toBeNull();
  });

  it('returns null when the selection is not in a textblock', () => {
    const view = fakeView('x', 1);
    view.state.doc.resolve = () =>
      ({ parentOffset: 0, parent: { isTextblock: false, textBetween: () => '' } }) as never;
    expect(captureSlashTokenRange(view)).toBeNull();
  });
});

describe('replaceCapturedRange — routes through the PARSER, not raw DOM', () => {
  // A stand-in for the parse-insert action factory (modelled on @milkdown/utils
  // replaceRange): the real one parses the markdown and returns a (ctx)=>void
  // macro. We assert the FIX calls it (the bug called node.insertData instead).
  const parseInsert = vi.fn((markdown: string, range: { from: number; to: number }) => ({
    __parseInsert: true,
    markdown,
    range,
  }));

  it('parses the AI markdown via editor.action(parseInsert(...)) at the captured range', () => {
    parseInsert.mockClear();
    const action = vi.fn();
    const editor: SlashEditor = { action };
    const view = fakeView('write /draft', 13);
    const cap = captureSlashTokenRange(view);

    const md = '# Title\n\nSome body.\n\n- a\n- b';
    const ok = replaceCapturedRange(editor, view, cap, md, parseInsert);

    expect(ok).toBe(true);
    // The PARSER path: the action is built with the FULL markdown (so `#`/lists
    // are parsed) at the captured token range — not the live caret.
    expect(parseInsert).toHaveBeenCalledWith(md, { from: 7, to: 13 });
    // And it was run through the editor instance (the toolbar-style path), not
    // a raw DOM insertData.
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(parseInsert.mock.results[0]?.value);
  });

  it('places the result at the CAPTURED range even after the caret moved (root-cause fix)', () => {
    parseInsert.mockClear();
    const editor: SlashEditor = { action: vi.fn() };
    const view = fakeView('write /draft', 13);
    const cap = captureSlashTokenRange(view);

    // The user moved the caret to the START during the AI await.
    view.state.selection.from = 1;

    replaceCapturedRange(editor, view, cap, 'Hello world.', parseInsert);
    // Still targets the captured /draft range (7..13), NOT the moved caret (1).
    expect(parseInsert).toHaveBeenCalledWith('Hello world.', { from: 7, to: 13 });
  });

  it('empty markdown deletes the captured token (orphaned-token cleanup, finding 213)', () => {
    parseInsert.mockClear();
    const editor: SlashEditor = { action: vi.fn() };
    const view = fakeView('write /draft', 13);
    const cap = captureSlashTokenRange(view);

    const ok = replaceCapturedRange(editor, view, cap, '', parseInsert);
    expect(ok).toBe(true);
    expect(parseInsert).toHaveBeenCalledWith('', { from: 7, to: 13 });
  });

  it('returns false WITHOUT calling the action when the range fell outside a shrunken doc (block deleted)', () => {
    parseInsert.mockClear();
    const action = vi.fn();
    const editor: SlashEditor = { action };
    const view = fakeView('write /draft', 13);
    const cap = captureSlashTokenRange(view); // to = 13

    // User deleted the block: doc now tiny, captured `to` (13) > docSize.
    const shrunk = fakeView('', 1); // docSize = 2
    const ok = replaceCapturedRange(editor, shrunk, cap, 'Hello', parseInsert);

    expect(ok).toBe(false); // caller warns instead of silently placing
    expect(action).not.toHaveBeenCalled();
    expect(parseInsert).not.toHaveBeenCalled();
  });

  it('returns false for a null capture / null editor / null view', () => {
    const editor: SlashEditor = { action: vi.fn() };
    const view = fakeView('x', 1);
    expect(replaceCapturedRange(editor, view, null, 'x', parseInsert)).toBe(false);
    expect(replaceCapturedRange(null, view, { from: 1, to: 1 }, 'x', parseInsert)).toBe(false);
    expect(replaceCapturedRange(editor, null, { from: 1, to: 1 }, 'x', parseInsert)).toBe(false);
  });
});
