/**
 * Operator cockpit chat — shared conversation-payload contract.
 *
 * Two cross-boundary primitives the server AND web both depend on, kept here so
 * neither side hand-mirrors the other (CLAUDE.md: API-boundary types live in
 * packages/shared):
 *
 *   1. `ENTITY_TYPES` — the CLOSED entity-reference enum the operator's
 *      `show_link_panel` tool emits. The server Zod-validates against it; the web
 *      `entityRoute` resolver switches on it. A single source means the web
 *      switch's exhaustiveness (`never`) guard fires at COMPILE time when the
 *      server enum widens — drift can't slip to runtime.
 *
 *   2. `parseMessagePayload` — the tolerant parser for a message's `payload`
 *      column (a JSON string for tool_step/component rows, null for text).
 *      Tolerant by design: a malformed / valid-JSON-but-non-object value
 *      ('null', '42', '"x"', '[...]') degrades to `{}` rather than throwing, so
 *      one bad row never aborts the whole thread render or the wedge-critical
 *      `.md` export. Both surfaces parse identically off this one function.
 */

/**
 * Closed entity-reference type set. The model never authors a raw route — it
 * names an entity by type, and the FRONTEND owns the type→route resolution.
 * Widening this enum is the ONLY way to add a navigable entity type, and it
 * widens both sides at once (server Zod + web resolver) off this single list.
 */
export const ENTITY_TYPES = [
  'document',
  'project',
  'view',
  'work_item',
  'agent',
  'trigger',
  'run',
  'conversation',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Parse a stored message `payload` defensively. A malformed/non-JSON value, or a
 * valid-JSON-but-non-object value (`null`, a number, a string, an array), MUST
 * degrade to `{}` rather than throw — markdown-as-source-of-truth is
 * wedge-critical, so one bad row renders an empty line, never breaks the thread.
 * Note `typeof [] === 'object'`, so arrays are explicitly excluded here.
 */
export function parseMessagePayload<T extends object>(payload: string | null): T {
  if (!payload) return {} as T;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : ({} as T);
  } catch {
    return {} as T;
  }
}
