import type { CompletionAction } from './api/ai-complete.ts';
import type { DocumentSummary } from './api/documents.ts';

export interface SlashContext {
  /** Project documents currently in cache — used by /link for fuzzy search. */
  documents: DocumentSummary[];
  /** Whether the workspace has a configured AI provider key. */
  aiConfigured: boolean;
  /** Insert text at the current cursor (replaces the slash + query token). */
  insert: (text: string) => void;
  /** Replace the current selection / slash query with raw markdown. */
  replace: (markdown: string) => void;
  /** Surface a toast or hint banner. */
  notify: (msg: string, kind?: 'info' | 'warning') => void;
  /**
   * Run a one-shot AI completion (the `/draft`, `/summarize`, `/decompose`
   * commands) against the current body and apply the result into the editor.
   * Provided by the body editor (where the body + wslug + title are in scope);
   * absent when no editor capability is wired (the items disable on
   * `aiConfigured` so this is reached only when it should exist).
   */
  aiComplete?: (action: CompletionAction) => Promise<void>;
}

export interface SlashItem {
  id: string;
  label: string;
  hint?: string;
  group: 'insert' | 'ai';
  /** When false, item appears in the menu greyed out and `onSelect` is replaced by a notify. */
  isEnabled?: (ctx: SlashContext) => boolean;
  /** Optional disabled-state hint shown in the menu. */
  disabledHint?: (ctx: SlashContext) => string;
  onSelect: (ctx: SlashContext, query: string) => void;
}

export const slashRegistry: SlashItem[] = [
  {
    id: 'link',
    label: 'Link to document',
    hint: '[[slug]] — fuzzy search documents',
    group: 'insert',
    onSelect: (ctx, query) => {
      const q = query.trim().toLowerCase();
      const match = ctx.documents
        .filter((d) => d.title.toLowerCase().includes(q) || d.slug.includes(q))
        .slice(0, 1)[0];
      if (match) {
        ctx.replace(`[[${match.slug}]]`);
      } else {
        ctx.notify('No matching document', 'warning');
      }
    },
  },
  {
    id: 'draft',
    label: 'Draft body',
    hint: 'Use the title to draft a body',
    group: 'ai',
    isEnabled: (ctx) => ctx.aiConfigured,
    disabledHint: () => 'Configure an AI provider in workspace settings',
    onSelect: (ctx) => void ctx.aiComplete?.('draft'),
  },
  {
    id: 'decompose',
    label: 'Decompose into subtasks',
    hint: 'Propose child documents',
    group: 'ai',
    isEnabled: (ctx) => ctx.aiConfigured,
    disabledHint: () => 'Configure an AI provider in workspace settings',
    onSelect: (ctx) => void ctx.aiComplete?.('decompose'),
  },
  {
    id: 'summarize',
    label: 'Summarize body',
    hint: 'One-paragraph summary',
    group: 'ai',
    isEnabled: (ctx) => ctx.aiConfigured,
    disabledHint: () => 'Configure an AI provider in workspace settings',
    onSelect: (ctx) => void ctx.aiComplete?.('summarize'),
  },
];

/** Filter the registry by query string + context. Returns enabled-aware items. */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) => it.label.toLowerCase().includes(q) || it.id.includes(q),
  );
}
