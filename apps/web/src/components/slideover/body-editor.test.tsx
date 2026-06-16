import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BodyEditor } from './body-editor.tsx';

describe('BodyEditor', () => {
  // Initial-markdown block-split rendering is a JSDOM limitation (ProseMirror
  // renders `# Hello\n\nworld` as one <h1> with no block-split — real parsing
  // needs a layout engine). Manually QA'd; tracked in docs/deferred-e2e-backlog.md.
  it('mounts without crashing and does not fire onChange on mount', () => {
    const onChange = vi.fn();
    render(<BodyEditor value="hi" onChange={onChange} />);
    // We can't easily simulate ProseMirror typing in jsdom. This test just
    // asserts the wrapper mounts without crashing and registers the listener;
    // round-trip is exercised in Task 19.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('mounts cleanly with the AI slash props wired (aiConfigured + wslug)', () => {
    // Seam: the AI slash path (aiComplete closure) only builds when the editor
    // is given a workspace slug + aiConfigured. This asserts the wiring doesn't
    // throw at construction. The async position-capture LOGIC is covered
    // un-mocked in lib/slash-capture.test.ts; the double-fire guard and the
    // error-toast branching live in the aiComplete closure, which requires a
    // live ProseMirror selection to invoke — deferred to the Playwright/Chrome
    // shake-out (jsdom can't drive the contenteditable selection movement).
    const onChange = vi.fn();
    render(<BodyEditor value="hi" onChange={onChange} aiConfigured wslug="acme" title="Doc" />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
