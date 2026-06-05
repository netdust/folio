import type { NavigateOptions } from '@tanstack/react-router';

/**
 * The closed entity-reference shape the operator's `show_link_panel` tool emits
 * (mirrors apps/server/src/lib/ui-tool.ts ENTITY_TYPES). The model never authors
 * a raw route — it names an entity by type + id + workspace, and the FRONTEND
 * owns the type→route resolution. Adding a new entity type widens the enum on
 * BOTH sides (server schema + this resolver) — no free-form navigation surface.
 */
export type EntityType =
  | 'document'
  | 'project'
  | 'view'
  | 'work_item'
  | 'agent'
  | 'run'
  | 'conversation';

export interface EntityTarget {
  entityType: EntityType;
  entityId: string;
  wslug: string;
}

/**
 * The SINGLE place entityType → route lives (T10). Returns TanStack-Router
 * NavigateOptions resolving an entity target to a destination in the main area.
 *
 * A link_panel click navigates the main area while the cockpit (a layout-level
 * panel, not a modal) STAYS OPEN. Targets carry only {entityType, entityId,
 * wslug} — no project slug — so document-shaped entities open via the
 * workspace-layout `?wdoc=` slideover param (distinct from the project `?doc=`),
 * which is reachable from anywhere under /w/$wslug without a project context.
 * Entity types that have a dedicated workspace surface (agent) route there;
 * the rest land on the workspace root, the safest reachable destination.
 */
export function entityRoute(target: EntityTarget): NavigateOptions {
  const { entityType, entityId, wslug } = target;
  switch (entityType) {
    case 'document':
    case 'work_item':
    case 'run':
    case 'conversation':
      // Document-shaped entities (agent_run is a document; conversations surface
      // in the cockpit which is already open) → workspace-layout slideover.
      return { to: '/w/$wslug', params: { wslug }, search: { wdoc: entityId } };
    case 'agent':
      // Agents have a dedicated workspace surface; open it on the agent.
      return { to: '/w/$wslug/agents', params: { wslug }, search: { wdoc: entityId } };
    case 'project':
    case 'view':
      // No project-slug in the target → land on the workspace root (reachable
      // from anywhere); the user picks the project/view from the rail.
      return { to: '/w/$wslug', params: { wslug } };
    default: {
      // Exhaustiveness guard — a new EntityType must be handled above.
      const _never: never = entityType;
      return { to: '/w/$wslug', params: { wslug: (target as EntityTarget).wslug } };
    }
  }
}
