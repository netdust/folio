/**
 * The closed set of AI providers — the SINGLE runtime source. A leaf module (no
 * imports) so both the barrel (index.ts) and operator-model-schema.ts can import
 * it without a cycle. The `AiProvider` type is derived from this array so the two
 * can't drift.
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'ollama'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
