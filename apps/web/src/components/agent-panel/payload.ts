/**
 * Parse a message's `payload` (a JSON string for tool_step/component rows, null
 * for text). Tolerant by design — a malformed / valid-JSON-but-non-object value
 * degrades to `{}` rather than throwing, so one bad row never breaks the thread
 * render (markdown-as-source-of-truth: a thread always renders).
 *
 * Cluster-5 /code-review fix: the parser is the SINGLE shared implementation in
 * `@folio/shared` (was byte-duplicated with the server's `parsePayload`). This
 * module re-exports it so existing renderer imports stay stable.
 */
export { parseMessagePayload } from '@folio/shared';
