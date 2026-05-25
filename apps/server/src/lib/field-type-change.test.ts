import { describe, expect, it } from 'bun:test';
import { validateTypeChange } from './field-type-change.ts';

describe('validateTypeChange', () => {
  it('accepts string → text and back', () => {
    expect(validateTypeChange('string', 'text').ok).toBe(true);
    expect(validateTypeChange('text', 'string').ok).toBe(true);
  });

  it('accepts number → currency and back', () => {
    expect(validateTypeChange('number', 'currency').ok).toBe(true);
    expect(validateTypeChange('currency', 'number').ok).toBe(true);
  });

  it('accepts any → text', () => {
    expect(validateTypeChange('number', 'text').ok).toBe(true);
    expect(validateTypeChange('date', 'text').ok).toBe(true);
    expect(validateTypeChange('select', 'text').ok).toBe(true);
    expect(validateTypeChange('multi_select', 'text').ok).toBe(true);
    expect(validateTypeChange('boolean', 'text').ok).toBe(true);
  });

  it('accepts same → same (no-op)', () => {
    expect(validateTypeChange('number', 'number').ok).toBe(true);
    expect(validateTypeChange('select', 'select').ok).toBe(true);
  });

  it('rejects incompatible changes with a clear reason', () => {
    const r = validateTypeChange('number', 'select');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/number → select/);
    }
  });

  it('rejects date ↔ number', () => {
    expect(validateTypeChange('date', 'number').ok).toBe(false);
    expect(validateTypeChange('number', 'date').ok).toBe(false);
  });

  it('rejects select ↔ multi_select', () => {
    expect(validateTypeChange('select', 'multi_select').ok).toBe(false);
    expect(validateTypeChange('multi_select', 'select').ok).toBe(false);
  });
});
