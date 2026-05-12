import type { ReactNode } from 'react';

export interface CommandContext {
  /** Current pathname — derive workspace/project from this. */
  pathname: string;
  /** Active workspace slug, if inside one. */
  workspaceSlug: string | null;
  /** Active project slug, if inside one. */
  projectSlug: string | null;
  /** Imperative navigate. */
  navigate: (to: string) => void;
  /** Theme toggle hook value. */
  toggleTheme: () => void;
}

export interface CommandResult {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  group: 'navigation' | 'create' | 'tools';
  onSelect: () => void;
}

export interface CommandProvider {
  /** Stable id used to dedupe and key the rendered items. */
  id: string;
  /** Returns the items this provider contributes for the given context + query. */
  resolve: (ctx: CommandContext, query: string) => Promise<CommandResult[]> | CommandResult[];
}

// === Static providers — known at design time, no async data needed ===

export const themeProvider: CommandProvider = {
  id: 'theme',
  resolve: (ctx) => [
    {
      id: 'theme.toggle',
      label: 'Toggle theme',
      group: 'tools',
      onSelect: () => ctx.toggleTheme(),
    },
  ],
};

/** Filter helper — case-insensitive substring on label. */
export function matches(item: { label: string }, query: string): boolean {
  if (!query.trim()) return true;
  return item.label.toLowerCase().includes(query.trim().toLowerCase());
}
