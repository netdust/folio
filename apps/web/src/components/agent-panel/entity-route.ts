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
}

/**
 * The SINGLE place entityType → route lives (T10). Returns TanStack-Router
 * NavigateOptions resolving an entity target to a destination in the main area.
 * A link_panel click navigates the main area while the cockpit (a layout-level
 * panel, not a modal) STAYS OPEN.
 *
 * v1 scope (Cluster-5 /code-review fix — finding #1): the resolver only emits a
 * deep-link for entity types that have a REACHABLE workspace-layout surface
 * keyed by the {entityType, entityId, wslug} the target carries:
 *   - `agent` / `trigger` → the workspace `?wdoc=<slug>` slideover (the ONLY
 *     types its GET handler resolves — workspace-documents.ts accepts agent|trigger).
 * Every other type degrades to the workspace ROOT (the safest reachable
 * destination), NOT a `?wdoc=` link that would 404: `document`/`work_item` live
 * under a project route needing a project slug the target doesn't carry; `run`
 * and `conversation` have no by-id workspace-layout slideover yet. Full doc /
 * work_item deep-linking is a follow-up (needs an id-keyed workspace document
 * slideover + an untyped server lookup). The operator's tool guidance steers it
 * to prefer agent/project links until then.
 */
export function entityRoute(target: EntityTarget): NavigateOptions {
  const { entityType, entityId, wslug } = target;
  switch (entityType) {
    case 'agent':
    case 'trigger':
      // The only types the ?wdoc= slideover resolves (agent + trigger, by slug).
      return { to: '/w/$wslug/agents', params: { wslug }, search: { wdoc: entityId } };
    case 'document':
    case 'work_item':
    case 'run':
    case 'conversation':
    case 'project':
    case 'view':
      // No reachable by-id/by-slug workspace-layout surface from the target alone
      // → land on the workspace root (reachable from anywhere); the user picks
      // the entity from the rail. Degrade, never 404.
      return { to: '/w/$wslug', params: { wslug } };
    default: {
      // Exhaustiveness guard — a new EntityType must be handled above. Fires at
      // COMPILE time because EntityType is the shared single source.
      const _never: never = entityType;
      return { to: '/w/$wslug', params: { wslug: (target as EntityTarget).wslug } };
    }
  }
}
