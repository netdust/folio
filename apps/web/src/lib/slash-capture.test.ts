import { describe, it, expect, beforeEach } from 'vitest';
import { captureSlashToken, applyAtCapturedRange } from './slash-capture.ts';

/**
 * These tests exercise the position-capture root-cause fix for the ASYNC slash
 * commands (findings 210/201/211/171): the slash token's span is snapshotted
 * BEFORE the multi-second AI await, and the result is placed at THAT captured
 * span — even after the live caret has moved.
 *
 * jsdom supports Text nodes, Range, deleteContents, insertData, and
 * Node.isConnected, so the real apply logic runs here un-mocked. (The contentful
 * ProseMirror selection movement that motivates the fix is simulated by mutating
 * the node/selection between capture and apply — the faithful end-to-end caret
 * drive is deferred to the Playwright/Chrome shake-out.)
 */
describe('slash-capture', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.appendChild(host);
  });

  /** Put a single text node in `host` and place the caret at `offset`. */
  function setText(content: string, offset: number): Text {
    const node = document.createTextNode(content);
    host.appendChild(node);
    const sel = window.getSelection();
    if (!sel) throw new Error('no selection');
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset);
    sel.addRange(range);
    return node;
  }

  it('captures the slash-token span at the caret (the `/` through the caret)', () => {
    setText('write /draft', 12); // caret after "/draft"
    const cap = captureSlashToken(window.getSelection());
    expect(cap).not.toBeNull();
    expect(cap?.slashStart).toBe(6); // index of "/"
    expect(cap?.tokenEnd).toBe(12);
  });

  it('places the AI result at the CAPTURED token even after the caret moved (root-cause fix)', () => {
    const node = setText('write /draft', 12);
    const cap = captureSlashToken(window.getSelection());

    // Simulate the user moving the caret to the START during the AI await.
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const moved = document.createRange();
    moved.setStart(node, 0);
    moved.setEnd(node, 0);
    sel?.addRange(moved);

    const ok = applyAtCapturedRange(cap, 'Hello world.');
    expect(ok).toBe(true);
    // The "/draft" token (indices 6..12) is replaced — NOT the moved caret at 0.
    expect(node.data).toBe('write Hello world.');
  });

  it('places the result at the captured token even after MORE text was typed after it', () => {
    // User typed "/draft" then kept typing " and more" before the AI resolved.
    const node = setText('write /draft', 12);
    const cap = captureSlashToken(window.getSelection());
    node.insertData(12, ' and more'); // now "write /draft and more"

    const ok = applyAtCapturedRange(cap, 'AI');
    expect(ok).toBe(true);
    // Only the captured 6..12 span is replaced; the later-typed text is kept.
    expect(node.data).toBe('write AI and more');
  });

  it('empty replacement deletes the captured token (orphaned-token cleanup, finding 213)', () => {
    const node = setText('write /draft', 12);
    const cap = captureSlashToken(window.getSelection());
    const ok = applyAtCapturedRange(cap, '');
    expect(ok).toBe(true);
    expect(node.data).toBe('write ');
  });

  it('returns false when the captured node was detached (user deleted the block)', () => {
    const node = setText('write /draft', 12);
    const cap = captureSlashToken(window.getSelection());
    node.remove(); // user deleted the whole block during the await
    expect(node.isConnected).toBe(false);
    const ok = applyAtCapturedRange(cap, 'Hello');
    expect(ok).toBe(false); // caller warns instead of silently dropping
  });

  it('captures the caret position when there is no `/` token (slashStart === tokenEnd)', () => {
    const node = setText('plain text', 10);
    const cap = captureSlashToken(window.getSelection());
    expect(cap?.slashStart).toBe(10);
    expect(cap?.tokenEnd).toBe(10);
    // Apply inserts at the caret without deleting anything.
    applyAtCapturedRange(cap, 'X');
    expect(node.data).toBe('plain textX');
  });

  it('clamps offsets to the node length if the text shrank after capture', () => {
    const node = setText('write /draft', 12);
    const cap = captureSlashToken(window.getSelection());
    node.deleteData(8, 4); // shrink: "write /dt" (len 9)
    const ok = applyAtCapturedRange(cap, '!');
    expect(ok).toBe(true);
    // start clamps to min(6,9)=6, end clamps to min(12,9)=9 → replaces "/dt".
    expect(node.data).toBe('write !');
  });

  it('returns null when there is no selection', () => {
    expect(captureSlashToken(null)).toBeNull();
  });

  it('applyAtCapturedRange returns false for a null capture', () => {
    expect(applyAtCapturedRange(null, 'x')).toBe(false);
  });
});
