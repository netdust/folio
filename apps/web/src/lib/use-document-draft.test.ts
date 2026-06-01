import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocumentDraft } from './use-document-draft.ts';

const baseDoc = {
  id: 'd1',
  updatedAt: '2026-01-01T00:00:00Z',
  body: '# Hello',
  frontmatter: { priority: 'low' } as Record<string, unknown>,
};

describe('useDocumentDraft', () => {
  it('seeds from the doc and is not dirty initially', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    expect(result.current.draft).toEqual({ body: '# Hello', frontmatter: { priority: 'low' } });
    expect(result.current.isDirty).toBe(false);
  });

  it('setBody makes it dirty and diff returns only body', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    act(() => result.current.setBody('# Changed'));
    expect(result.current.isDirty).toBe(true);
    expect(result.current.diff()).toEqual({ patch: { body: '# Changed' }, keys: ['body'] });
  });

  it('setFrontmatter shallow-merges and diff returns only changed keys', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    act(() => result.current.setFrontmatter({ priority: 'high' }));
    expect(result.current.isDirty).toBe(true);
    const d = result.current.diff();
    expect(d.patch).toEqual({ frontmatter: { priority: 'high' } });
    expect(d.keys).toEqual(['priority']);
  });

  it('reset discards edits', () => {
    const { result } = renderHook(() => useDocumentDraft(baseDoc));
    act(() => result.current.setBody('# Changed'));
    act(() => result.current.reset());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.draft.body).toBe('# Hello');
  });

  it('re-seeds when doc.id changes (doc switch)', () => {
    const { result, rerender } = renderHook(({ doc }) => useDocumentDraft(doc), {
      initialProps: { doc: baseDoc },
    });
    act(() => result.current.setBody('# Changed'));
    rerender({ doc: { ...baseDoc, id: 'd2', body: '# Other' } });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.draft.body).toBe('# Other');
  });

  it('re-seeds when doc.updatedAt changes (post-save) and clears dirty', () => {
    const { result, rerender } = renderHook(({ doc }) => useDocumentDraft(doc), {
      initialProps: { doc: baseDoc },
    });
    act(() => result.current.setBody('# Saved body'));
    // Simulate the server returning the saved doc with the new body + updatedAt.
    rerender({ doc: { ...baseDoc, body: '# Saved body', updatedAt: '2026-01-02T00:00:00Z' } });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.draft.body).toBe('# Saved body');
  });
});
