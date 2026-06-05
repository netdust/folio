/**
 * Operator cockpit chat — the `ui` tool surface (Task 3).
 *
 * Two CHAT-ONLY tools the operator calls to render structured components into
 * the conversation thread:
 *   - `show_link_panel` — surface a clickable reference to an entity.
 *   - `ask_choice`      — present a multi-option choice card.
 *
 * Schemas live here (pure, importable by tests + the registry); the tool DEFs
 * are registered in `agent-tools-registry.ts` so they share the one
 * `executeTool` auth/dispatch point. Both map to `documents:read` — emitting UI
 * is not a privileged op; the UNDERLYING action the operator later takes carries
 * the risk and is gated separately (T7).
 */

import { z } from 'zod';
import { ENTITY_TYPES } from '@folio/shared';

/**
 * Extensible-but-CLOSED entity reference (NOT a free-form route — a model-
 * authored route string would be an open-navigation surface, exactly what the
 * closed `ui` tool avoids). `entityType` is an enum the FRONTEND resolves to a
 * route (frontend owns routing, not the model); adding a new entity type later
 * widens the enum on both sides — no schema-shape churn, no raw routes. `wslug`
 * scopes the reference. The enum is the SINGLE shared source in
 * `@folio/shared` (Cluster-5 /code-review fix — was hand-mirrored web↔server),
 * so the web `entityRoute` switch's exhaustiveness guard fires at compile time
 * when this widens. Re-exported for existing server importers.
 */
export { ENTITY_TYPES };

export const linkPanelSchema = z
  .object({
    target: z
      .object({
        entityType: z.enum(ENTITY_TYPES),
        entityId: z.string().min(1),
        wslug: z.string().min(1),
      })
      .strict(),
    title: z.string().min(1),
    subtitle: z.string().optional(),
  })
  .strict();

export const choiceCardSchema = z
  .object({
    prompt: z.string().min(1),
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }).strict())
      .min(2),
  })
  .strict();

export type LinkPanelArgs = z.infer<typeof linkPanelSchema>;
export type ChoiceCardArgs = z.infer<typeof choiceCardSchema>;
