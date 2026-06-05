export type AiProvider = 'anthropic' | 'openai' | 'openrouter' | 'ollama';

/** Shape of an AI key's metadata (no secret). Kept here as the shared type;
 *  the instance-level CRUD hooks live in `instance-ai-keys.ts`. The per-workspace
 *  AI-key client was removed when AI keys went instance-level (the server route
 *  /w/:wslug/settings/:workspaceId/ai-keys no longer exists). */
export interface AiKey {
  id: string;
  provider: AiProvider;
  label: string;
  baseUrl: string | null;
  createdAt: string;
}
