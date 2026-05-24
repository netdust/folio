import { describe, it, expect } from 'vitest';
import { ApiError } from './client.ts';
import { formatApiError, apiErrorCode } from './errors.ts';

describe('formatApiError', () => {
  it('uses message from API error envelope', () => {
    const err = new ApiError(409, { error: { code: 'SLUG_TAKEN', message: 'Slug already exists' } });
    expect(formatApiError(err)).toBe('Slug already exists');
  });

  it('falls back to status for ApiError without envelope', () => {
    const err = new ApiError(500, null);
    expect(formatApiError(err)).toBe('Something went wrong');
  });

  it('falls back for non-ApiError', () => {
    expect(formatApiError(new Error('boom'))).toBe('boom');
    expect(formatApiError('boom')).toBe('Something went wrong');
  });
});

describe('apiErrorCode', () => {
  it('extracts code from ApiError envelope', () => {
    const err = new ApiError(409, { error: { code: 'SLUG_TAKEN', message: 'x' } });
    expect(apiErrorCode(err)).toBe('SLUG_TAKEN');
  });

  it('returns null for non-API errors', () => {
    expect(apiErrorCode(new Error('boom'))).toBeNull();
    expect(apiErrorCode('boom')).toBeNull();
  });
});
