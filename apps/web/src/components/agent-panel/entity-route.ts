import type { NavigateOptions } from '@tanstack/react-router';
import type { EntityType } from '@folio/shared';

export type { EntityType };

/**
 * The closed entity-reference shape the operator's `show_link_panel` tool emits.
 * The model never authors a raw route — it names an entity by type + id +
 * workspace, and the FRONTEND owns the type→route resolution. The `EntityType`
 * enum is the SINGLE shared source (`@folio/shared`), so the switch below fails
 * to compile (the `never` guard) if the server widens the enum without a route
 * here. `entityId` is the entity's SLUG for slug-resolved surfaces (agent /
 * trigger); the value is operator-supplied and unconstrained, so the resolver
 * never trusts it for anything but the destination param.
 */
export interface EntityTarget {
  entityType: EntityType;
  entityId: string;
  wslug: string;
  /**
   * The project slug. REQUIRED for project-scoped entities (document/work_item),
   * which open at the project route; omitted for workspace-level entities
   * (agent/trigger). The server schema enforces its presence for the former.
   */
  pslug?: string;
}

/**
 * The SINGLE place entityType → route lives (T10). Returns TanStack-Router
 * NavigateOptions resolving an entity target to a destination in the main area.
 * A link_panel click navigates the main area while the cockpit (a layout-level
 * panel, not a modal) STAYS OPEN — the entity opens BESIDE the chat.
 *
 *   - `document` / `work_item` → the project route `/w/<wslug>/p/<pslug>/work-items`
 *     with `?doc=<slug>`, which opens the project DocumentSlideover — the SAME
 *     surface a manual browser nav reaches. Requires `pslug` (carried on the
 *     target, enforced by the server schema).
 *   - `agent` / `trigger` → the workspace `?wdoc=<slug>` slideover.
 *   - `run` / `conversation` → no by-id slideover exists yet → degrade to the
 *     workspace root (reachable; the user picks from the rail). `project` / `view`
 *     likewise land on the workspace root.
 */
export function entityRoute(target: EntityTarget): NavigateOptions {
  const { entityType, entityId, wslug, pslug } = target;
  switch (entityType) {
    case 'document':
    case 'work_item':
      // Project DocumentSlideover via ?doc= (needs the project slug). If pslug is
      // somehow absent (schema should prevent it), degrade to the workspace root.
      if (!pslug) return { to: '/w/$wslug', params: { wslug } };
      return {
        to: '/w/$wslug/p/$pslug/work-items',
        params: { wslug, pslug },
        search: { doc: entityId },
      };
    case 'agent':
    case 'trigger':
      // The types the workspace ?wdoc= slideover resolves (by slug).
      return { to: '/w/$wslug/agents', params: { wslug }, search: { wdoc: entityId } };
    case 'run':
    case 'conversation':
    case 'project':
    case 'view':
      // No by-id/by-slug surface from the target alone → land on the workspace
      // root (reachable from anywhere); the user picks from the rail. Degrade,
      // never 404.
      return { to: '/w/$wslug', params: { wslug } };
    default: {
      // Exhaustiveness guard — a new EntityType must be handled above. Fires at
      // COMPILE time because EntityType is the shared single source.
      const _never: never = entityType;
      return { to: '/w/$wslug', params: { wslug: (target as EntityTarget).wslug } };
    }
  }
}
