import { describe, expect, test } from 'bun:test';
import { openrouter } from './openrouter.ts';

describe('openrouter provider', () => {
  test('exposes stream + testKey', () => {
    expect(typeof openrouter.stream).toBe('function');
    expect(typeof openrouter.testKey).toBe('function');
  });
});
