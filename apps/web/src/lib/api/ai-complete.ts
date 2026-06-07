import { client } from './client.ts';

export type CompletionAction = 'draft' | 'summarize' | 'decompose';

export interface CompleteArgs {
  action: CompletionAction;
  content: string;
  title?: string;
  instruction?: string;
}

/**
 * One-shot, read-only AI completion for the editor slash-commands
 * (`/draft`, `/summarize`, `/decompose`). The server transforms the supplied
 * `content` (never reads a document) and returns the generated text; the editor
 * applies it. Imperative (not a hook) so a slash-menu `onSelect` can await it.
 */
export async function completeAi(wslug: string, args: CompleteArgs): Promise<{ text: string }> {
  return client.post<{ text: string }>(`/api/v1/w/${wslug}/ai/complete`, {
    action: args.action,
    content: args.content,
    ...(args.title ? { title: args.title } : {}),
    ...(args.instruction ? { instruction: args.instruction } : {}),
  });
}
