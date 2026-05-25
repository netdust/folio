import { describe, expect, it } from 'vitest';
import { fieldsKeys } from './fields.ts';

describe('fieldsKeys', () => {
  it('list key includes wslug, pslug and tslug', () => {
    expect(fieldsKeys.list('acme', 'sales', 'work-items')).toEqual([
      'fields',
      'acme',
      'sales',
      'work-items',
    ]);
  });
});
