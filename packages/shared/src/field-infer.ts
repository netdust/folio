import type { FieldType } from './index.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$/;
const DOCUMENT_REF_RE = /^\[\[[\w-]+\]\]$/;

export interface InferContext {
  knownEmails?: Set<string>;
  knownSlugs?: Set<string>;
}

export function inferFieldType(value: unknown, ctx: InferContext = {}): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return 'multi_select';
    return 'string';
  }
  if (typeof value !== 'string') return 'string';

  if (DATETIME_RE.test(value)) return 'datetime';
  if (DATE_RE.test(value)) return 'date';
  if (EMAIL_RE.test(value) && ctx.knownEmails?.has(value)) return 'user_ref';
  if (/^(https?:\/\/|mailto:)/.test(value)) return 'url';
  if (DOCUMENT_REF_RE.test(value)) return 'document_ref';
  if (value.includes('\n')) return 'text';
  return 'string';
}
