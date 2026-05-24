import type { ReactNode } from 'react';
import type { NavItem } from '../components/shell/rail.tsx';

export interface RailTreeProject {
  slug: string;
  name: string;
  icon?: string | null;
}

export interface RailTreeTable {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
}

export interface RailTreeView {
  id: string;
  name: string;
  type: 'list' | 'kanban';
  isDefault: boolean;
  order: number;
}

export interface RailTreeRoute {
  wslug: string;
  pslug?: string;
  tslug?: string;
  viewId?: string;
}

export interface RailTreeHandlers {
  onProjectClick?: (pslug: string) => void;
  onTableClick?: (pslug: string, tslug: string) => void;
  onViewClick: (pslug: string, tslug: string, viewId: string) => void;
  onNewView: (pslug: string, tslug: string) => void;
  /** Render a trailing slot (e.g. a + IconButton) for a table row. Pure render fn — caller supplies the JSX. */
  renderNewViewTrailing?: (pslug: string, tslug: string) => ReactNode;
}

export interface RailTreeInput {
  projects: RailTreeProject[];
  tablesByProject: Record<string, RailTreeTable[]>;
  viewsByTable: Record<string, RailTreeView[]>;
  currentRoute: RailTreeRoute;
  handlers: RailTreeHandlers;
}

export function buildRailTree(input: RailTreeInput): NavItem[] {
  const { projects, tablesByProject, viewsByTable, currentRoute, handlers } = input;

  return projects.map((project): NavItem => {
    const tables = tablesByProject[project.slug] ?? [];

    const tableNavItems: NavItem[] = tables.map((table): NavItem => {
      const rawViews = viewsByTable[table.id] ?? [];
      const listViews = rawViews.filter((v) => v.type !== 'kanban');
      const sortedViews = [...listViews].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return Number(b.isDefault) - Number(a.isDefault);
      });

      const viewNavItems: NavItem[] = sortedViews.map((view): NavItem => ({
        id: `view:${table.id}:${view.id}`,
        label: view.name,
        active: currentRoute.viewId === view.id && currentRoute.pslug === project.slug,
        onClick: () => handlers.onViewClick(project.slug, table.slug, view.id),
      }));

      return {
        id: `table:${project.slug}:${table.slug}`,
        label: table.name,
        onClick: handlers.onTableClick
          ? () => handlers.onTableClick!(project.slug, table.slug)
          : undefined,
        children: viewNavItems,
        trailing: handlers.renderNewViewTrailing
          ? handlers.renderNewViewTrailing(project.slug, table.slug)
          : undefined,
      };
    });

    return {
      id: `project:${project.slug}`,
      label: project.name,
      onClick: handlers.onProjectClick
        ? () => handlers.onProjectClick!(project.slug)
        : undefined,
      children: tableNavItems,
    };
  });
}
