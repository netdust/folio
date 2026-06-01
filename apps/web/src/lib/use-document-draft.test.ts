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

  it('ignores server-managed frontmatter keys: not dirty at rest, never in the diff', () => {
    // Agent/trigger docs carry server-injected keys (api_token_id, last_fired_at,
    // last_touched_at, …). The agent/trigger PATCH schema is .strict() and rejects
    // them, and the server drops them on merge anyway. So the draft must neither
    // count them toward isDirty nor echo them back in the diff.
    const docWithManaged = {
      id: 'a1',
      updatedAt: '2026-01-01T00:00:00Z',
      body: '# Agent',
      frontmatter: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        api_token_id: 'tok_123', // server-managed
        last_touched_at: '2026-01-01', // server-managed
      } as Record<string, unknown>,
    };
    const { result } = renderHook(() => useDocumentDraft(docWithManaged));
    // Untouched → not dirty, even though server-managed keys are present.
    expect(result.current.isDirty).toBe(false);
    // Edit a real field.
    act(() => result.current.setFrontmatter({ model: 'claude-opus-4-8' }));
    expect(result.current.isDirty).toBe(true);
    const d = result.current.diff();
    // The patch frontmatter must NOT carry api_token_id / last_touched_at.
    expect(d.patch.frontmatter).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(d.keys).toEqual(['model']);
  });

  it('seed-once: a prop change does NOT re-seed (owner remounts via key for that)', () => {
    // The hook seeds once per mount. React Query toggles `doc` on refetch, and an
    // in-place re-seed oscillated (re-seed → stomp → empty). So the hook ignores
    // prop changes entirely; the OWNER remounts the draft subtree (React key on
    // doc.id+updatedAt) to get a fresh seed. Here a rerender with a different doc
    // must leave the draft untouched.
    const { result, rerender } = renderHook(({ doc }) => useDocumentDraft(doc), {
      initialProps: { doc: baseDoc },
    });
    rerender({ doc: { ...baseDoc, id: 'd2', updatedAt: '2026-09-09T00:00:00Z', body: '# Other' } });
    // Draft unchanged (still the original seed) — proves no in-place re-seed.
    expect(result.current.draft.body).toBe('# Hello');
  });

  it('remount (fresh mount) seeds from the new doc — how the owner switches docs', () => {
    // The owner keys the subtree on doc version; a switch/post-save bump remounts
    // the hook, which seeds fresh from the new doc. Modeled here as a new
    // renderHook call (= remount).
    const a = renderHook(() => useDocumentDraft(baseDoc));
    expect(a.result.current.draft.body).toBe('# Hello');
    const b = renderHook(() => useDocumentDraft({ ...baseDoc, id: 'd2', body: '# Other' }));
    expect(b.result.current.draft.body).toBe('# Other');
    expect(b.result.current.isDirty).toBe(false);
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

  it('post-save: remounting on the new version clears dirty', () => {
    // After a save the server returns a bumped updatedAt; the owner remounts the
    // subtree on the new version, re-seeding fresh from the saved doc → clean.
    const saved = { ...baseDoc, body: '# Saved body', updatedAt: '2026-01-02T00:00:00Z' };
    const { result } = renderHook(() => useDocumentDraft(saved));
    expect(result.current.draft.body).toBe('# Saved body');
    expect(result.current.isDirty).toBe(false);
  });
});
