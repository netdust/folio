import { FolderOpen, Table2, List, Columns3, FileText } from 'lucide-react';
import type { NavItem, RowMenuItem } from '../components/shell/rail.tsx';

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
  onWikiClick?: (pslug: string) => void;
  onNewProject?: () => void;
  onNewTable?: (pslug: string) => void;
  onNewView: (pslug: string, tslug: string) => void;
  onRenameProject?: (pslug: string, next: string) => void;
  onDeleteProject?: (pslug: string, name: string) => void;
  onRenameTable?: (pslug: string, tslug: string, next: string) => void;
  onDeleteTable?: (pslug: string, tslug: string, name: string) => void;
  onRenameView?: (pslug: string, tslug: string, viewId: string, next: string) => void;
  onDeleteView?: (pslug: string, tslug: string, viewId: string, name: string) => void;
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
        lucideIcon: view.type === 'kanban' ? Columns3 : List,
        active: currentRoute.viewId === view.id && currentRoute.pslug === project.slug,
        onClick: () => handlers.onViewClick(project.slug, table.slug, view.id),
        onRename: handlers.onRenameView
          ? (next) => handlers.onRenameView!(project.slug, table.slug, view.id, next)
          : undefined,
        menuItems: buildViewMenu(handlers, project.slug, table.slug, view),
      }));

      return {
        id: `table:${project.slug}:${table.slug}`,
        label: table.name,
        lucideIcon: Table2,
        onClick: handlers.onTableClick
          ? () => handlers.onTableClick!(project.slug, table.slug)
          : undefined,
        children: viewNavItems,
        onPlus: () => handlers.onNewView(project.slug, table.slug),
        plusLabel: 'New view',
        onRename: handlers.onRenameTable
          ? (next) => handlers.onRenameTable!(project.slug, table.slug, next)
          : undefined,
        menuItems: buildTableMenu(handlers, project.slug, table),
      };
    });

    const wikiLeaf: NavItem | null = handlers.onWikiClick
      ? {
          id: `wiki:${project.slug}`,
          label: 'Wiki',
          lucideIcon: FileText,
          active: currentRoute.pslug === project.slug && currentRoute.tslug === undefined && currentRoute.viewId === undefined && false,
          onClick: () => handlers.onWikiClick!(project.slug),
        }
      : null;

    const projectChildren = wikiLeaf ? [...tableNavItems, wikiLeaf] : tableNavItems;

    return {
      id: `project:${project.slug}`,
      label: project.name,
      lucideIcon: FolderOpen,
      onClick: handlers.onProjectClick
        ? () => handlers.onProjectClick!(project.slug)
        : undefined,
      children: projectChildren,
      onPlus: handlers.onNewTable
        ? () => handlers.onNewTable!(project.slug)
        : undefined,
      plusLabel: 'New table',
      onRename: handlers.onRenameProject
        ? (next) => handlers.onRenameProject!(project.slug, next)
        : undefined,
      menuItems: buildProjectMenu(handlers, project),
    };
  });
}

// Menus only carry actions the parent can't infer. Rename is added implicitly
// by RailTreeNode when onRename is set (it triggers the inline edit mode).
function buildProjectMenu(h: RailTreeHandlers, project: RailTreeProject): RowMenuItem[] | undefined {
  const items: RowMenuItem[] = [];
  if (h.onDeleteProject) items.push({ label: 'Delete', destructive: true, onSelect: () => h.onDeleteProject!(project.slug, project.name) });
  return items.length > 0 ? items : undefined;
}

function buildTableMenu(h: RailTreeHandlers, pslug: string, table: RailTreeTable): RowMenuItem[] | undefined {
  const items: RowMenuItem[] = [];
  if (h.onDeleteTable) items.push({ label: 'Delete', destructive: true, onSelect: () => h.onDeleteTable!(pslug, table.slug, table.name) });
  return items.length > 0 ? items : undefined;
}

function buildViewMenu(h: RailTreeHandlers, pslug: string, tslug: string, view: RailTreeView): RowMenuItem[] | undefined {
  const items: RowMenuItem[] = [];
  if (h.onDeleteView) items.push({ label: 'Delete', destructive: true, onSelect: () => h.onDeleteView!(pslug, tslug, view.id, view.name) });
  return items.length > 0 ? items : undefined;
}
