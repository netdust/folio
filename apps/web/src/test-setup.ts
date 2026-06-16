import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Milkdown teardown-race guard (M3 / E6 — M2 follow-up).
//
// comments-tab.test.tsx renders CommentsTab → CommentComposer → a Milkdown
// editor. Milkdown's `@milkdown/ctx` Timing primitive schedules an internal
// `setTimeout` (its `#waitTimeout`) whose callback calls the *bare global*
// `removeEventListener`. When the editor is destroyed before that timing promise
// resolves, the timer is still pending and fires AFTER vitest has torn down the
// jsdom globals for that file, at which point `removeEventListener` no longer
// exists →
//   ReferenceError: removeEventListener is not defined
//     at Timer.#removeListener (@milkdown/ctx/lib/index.js:282:24)
//     at Timeout._onTimeout   (@milkdown/ctx/lib/index.js:286:5)
//
// ZERO tests fail (946 always pass). The late timer throws an *uncaught
// exception* that vitest surfaces as an "Unhandled Error" and uses to flip the
// process exit code to 1 (~40% of full-suite runs, worker-timing dependent —
// M2's +8 tests shifted the timing enough to surface it more). The timer is
// scheduled inside @milkdown/ctx and outlives the test file that created it
// (it can fire after that file's afterAll), so a file-local unmount/afterEach
// guard cannot reach it — only a worker-lifetime handler installed here can.
//
// This handler swallows ONLY that exact, known teardown ReferenceError — matched
// on BOTH the message AND a `@milkdown/ctx` stack origin — and RE-THROWS
// everything else, so any genuine unhandled rejection/exception still reds the
// run. It is deliberately NOT vitest's `dangerouslyIgnoreUnhandledErrors`
// (which is global and would hide real errors). Remove this guard if the
// upstream @milkdown/ctx teardown stops scheduling a post-destroy timer.
// ---------------------------------------------------------------------------
function isMilkdownTeardownRace(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'ReferenceError' &&
    /removeEventListener is not defined/.test(err.message ?? '') &&
    /@milkdown[/+]ctx/.test(err.stack ?? '')
  );
}

function milkdownTeardownGuard(err: unknown): void {
  if (isMilkdownTeardownRace(err)) return; // swallow ONLY the known teardown race
  throw err; // anything else is a real failure — let vitest red the run
}

// `process` exists in the vitest (node) runner but @types/node is not in this
// browser-targeted app's tsconfig (`types: ["vite/client"]`). Declare only the
// minimal listener surface used here rather than widening the app's type deps.
declare const process: {
  on(event: string, listener: (err: unknown) => void): void;
};
process.on('uncaughtException', milkdownTeardownGuard);
process.on('unhandledRejection', milkdownTeardownGuard);

// CodeMirror uses Range.getClientRects() for text measurement.
// jsdom does not implement it — stub it to return an empty DOMRectList
// so CodeMirror's layout pass doesn't throw an unhandled exception.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
