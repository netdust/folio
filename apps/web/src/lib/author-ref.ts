/**
 * S6: author-ref now lives in `@folio/shared` so the server (mention-parser,
 * comment-schema regex, authorString) and the web (comment-row, approval
 * buttons) share one source of truth. This file is a thin re-export so the
 * existing `../lib/author-ref.ts` import paths continue to work.
 */
export {
  AUTHOR_KINDS,
  AUTHOR_REF_RE,
  type AuthorKind,
  type AgentRef,
  type MemberRef,
  parseAuthorRef,
  authorDisplayName,
  authorAgentSlug,
  authorMatchesCurrent,
  authorString,
  stripAuthorPrefix,
} from '@folio/shared';
