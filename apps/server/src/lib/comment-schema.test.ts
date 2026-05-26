import { describe, expect, test } from 'bun:test';
import { CommentFrontmatterSchema } from './comment-schema.ts';

const BASE = { author: 'user:stefan' };

describe('CommentFrontmatterSchema — defaults', () => {
  test('parses a minimal valid comment with only author set', () => {
    const r = CommentFrontmatterSchema.safeParse(BASE);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.kind).toBe('comment');
      expect(r.data.visibility).toBe('normal');
      expect(r.data.mentions).toEqual([]);
    }
  });

  test('accepts all optional fields when valid', () => {
    const r = CommentFrontmatterSchema.safeParse({
      author: 'agent:summarizer',
      kind: 'plan',
      visibility: 'internal',
      mentions: [],
      edited_at: '2026-05-26T10:00:00.000Z',
      run_id: '018f9e6d-3f0b-7d2e-8b44-5a3b2e1d0c9f',
    });
    expect(r.success).toBe(true);
  });
});

describe('CommentFrontmatterSchema — approval / rejection requires target_agent', () => {
  test('requires target_agent when kind is approval', () => {
    const r = CommentFrontmatterSchema.safeParse({ ...BASE, kind: 'approval' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe(
        'target_agent is required when kind is approval or rejection',
      );
    }
  });

  test('requires target_agent when kind is rejection', () => {
    const r = CommentFrontmatterSchema.safeParse({ ...BASE, kind: 'rejection' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe(
        'target_agent is required when kind is approval or rejection',
      );
    }
  });

  test('accepts approval with target_agent set', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      kind: 'approval',
      target_agent: 'agent:deploy-bot',
    });
    expect(r.success).toBe(true);
  });

  test('accepts rejection with target_agent set', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      kind: 'rejection',
      target_agent: 'agent:deploy-bot',
    });
    expect(r.success).toBe(true);
  });
});

describe('CommentFrontmatterSchema — target_agent only valid for approval/rejection', () => {
  test('rejects target_agent when kind is comment', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      kind: 'comment',
      target_agent: 'agent:deploy-bot',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe(
        'target_agent is only valid when kind is approval or rejection',
      );
    }
  });

  test('rejects target_agent when kind is plan', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      kind: 'plan',
      target_agent: 'agent:x',
    });
    expect(r.success).toBe(false);
  });

  test('rejects target_agent when kind is result', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      kind: 'result',
      target_agent: 'agent:x',
    });
    expect(r.success).toBe(false);
  });

  test('rejects target_agent when kind is reply', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      kind: 'reply',
      target_agent: 'agent:x',
    });
    expect(r.success).toBe(false);
  });
});

describe('CommentFrontmatterSchema — mentions / ResolvedMentionSchema', () => {
  test('accepts a resolved mention with target + resolved + resolvedId + resolvedType', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      mentions: [
        {
          target: 'agent:deploy-bot',
          resolved: true,
          resolvedId: 'abc-123',
          resolvedType: 'agent',
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  test('accepts a mention with resolved: false and no resolvedId', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      mentions: [{ target: 'user:stefan', resolved: false }],
    });
    expect(r.success).toBe(true);
  });

  test('rejects a target string not matching user: or agent: prefix', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      mentions: [{ target: 'team:frontend', resolved: false }],
    });
    expect(r.success).toBe(false);
  });

  test('rejects a bare target string with no prefix', () => {
    const r = CommentFrontmatterSchema.safeParse({
      ...BASE,
      mentions: [{ target: 'stefan', resolved: false }],
    });
    expect(r.success).toBe(false);
  });
});

describe('CommentFrontmatterSchema — author validation', () => {
  test('rejects author with no prefix', () => {
    const r = CommentFrontmatterSchema.safeParse({ author: 'stefan' });
    expect(r.success).toBe(false);
  });

  test('rejects author with unsupported prefix', () => {
    const r = CommentFrontmatterSchema.safeParse({ author: 'system:bot' });
    expect(r.success).toBe(false);
  });

  test('accepts agent: prefixed author', () => {
    const r = CommentFrontmatterSchema.safeParse({ author: 'agent:summarizer' });
    expect(r.success).toBe(true);
  });
});

describe('CommentFrontmatterSchema — enum validation', () => {
  test('rejects unknown kind', () => {
    const r = CommentFrontmatterSchema.safeParse({ ...BASE, kind: 'note' });
    expect(r.success).toBe(false);
  });

  test('rejects unknown visibility', () => {
    const r = CommentFrontmatterSchema.safeParse({ ...BASE, visibility: 'private' });
    expect(r.success).toBe(false);
  });
});
