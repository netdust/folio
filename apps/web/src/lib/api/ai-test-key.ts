import { useMutation } from '@tanstack/react-query';
import { client } from './client.ts';
import type { AiProvider } from './settings.ts';

export type TestKeyArgs = {
  wslug: string;
  provider: AiProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
};

export type TestKeyResult = { ok: true } | { ok: false; reason: string };

export function useTestKey() {
  return useMutation<TestKeyResult, Error, TestKeyArgs>({
    mutationFn: ({ wslug, provider, model, apiKey, baseUrl }) =>
      client.post<TestKeyResult>(`/api/v1/w/${wslug}/ai/test-key`, {
        // Snake-case wire format (server validates with Zod that requires snake_case).
        provider,
        model,
        api_key: apiKey,
        ...(baseUrl ? { base_url: baseUrl } : {}),
      }),
  });
}
