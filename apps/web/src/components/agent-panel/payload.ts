/**
 * Parse a message's `payload` (a JSON string for tool_step/component rows, null
 * for text). Tolerant by design — a malformed payload returns `{}` rather than
 * throwing, so one bad row never breaks the whole thread render (markdown-as-
 * source-of-truth: a thread always renders). Mirrors the server-side
 * `parsePayload` tolerance in services/conversations.ts.
 */
export function parseMessagePayload<T extends object>(payload: string | null): T {
  if (!payload) return {} as T;
  try {
    const parsed = JSON.parse(payload);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}
