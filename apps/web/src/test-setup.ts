import '@testing-library/jest-dom/vitest';

// CodeMirror uses Range.getClientRects() for text measurement.
// jsdom does not implement it — stub it to return an empty DOMRectList
// so CodeMirror's layout pass doesn't throw an unhandled exception.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => ({
    top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0,
    x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
}
