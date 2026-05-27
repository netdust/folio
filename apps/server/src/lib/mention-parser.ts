import type { ResolvedMention } from './comment-schema.ts';

/**
 * Matches `@<slug>` only after whitespace or at line start.
 * The leading whitespace requirement prevents matching email addresses
 * like `jan@example.com` that appear mid-text.
 */
const TOKEN_RE = /(?:^|\s)@([a-z][a-z0-9-]+)/g;

/**
 * BUG-009 — mask markdown code spans + blockquote lines with equal-length
 * whitespace BEFORE tokenisation. Position-preserving so downstream offset
 * arithmetic (match.index, body.slice) keeps working.
 *
 * Three patterns, applied in order so overlaps resolve correctly:
 *   1. Fenced code blocks (``` and ~~~)
 *   2. Inline code (`...`) — backticks balanced, no inner newlines
 *   3. Blockquote-prefixed lines (`> ` or `>` at line start, optionally
 *      preceded by up to 3 spaces per CommonMark)
 *
 * Replaces the entire span — fences/backticks/prefix included — with spaces.
 * Newlines inside fenced blocks are preserved so blockquote scanning still
 * sees line boundaries.
 */
const FENCED_CODE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*|$)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const BLOCKQUOTE_LINE_RE = /(^|\n) {0,3}>[^\n]*/g;

function maskMarkdownNoise(body: string): string {
  // Replace `match` with whitespace of equal length, preserving newlines so
  // line-based regexes downstream still see line breaks correctly.
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  return body
    .replace(FENCED_CODE_RE, blank)
    .replace(INLINE_CODE_RE, blank)
    .replace(BLOCKQUOTE_LINE_RE, blank);
}

/**
 * Matches the past-participle approval/rejection keywords exactly.
 * Optional trailing punctuation is stripped to handle "rejected;" "rejected," etc.
 */
const KEYWORD_RE = /^(approved|rejected)[.,!;]?$/i;

/**
 * Position-1 words that are transparent: when position 1 is one of these, an
 * approval keyword at position 2 is still considered "near" the mention.
 * Core: "to be" forms (is, was, are, were, been, be).
 * Extended: perfect-tense auxiliaries (has, have, had), colloquial passives
 * (got, gets), and the temporal adverb "just" — all common in natural approval
 * phrases like "@drafter has approved", "@drafter got approved", "@drafter just
 * approved the plan". Non-qualifying verbs like "looks", "seems", "please" are
 * intentionally excluded to minimise false positives.
 */
const POS1_ADJACENCY_ALLOW = new Set([
  'is', 'was', 'are', 'were', 'been', 'be',
  'has', 'have', 'had',
  'got', 'gets',
  'just',
]);

export interface ParseMentionsInput {
  body: string;
  workspaceAgents: { id: string; slug: string; allowedProjectIds: string[] }[];
  workspaceMembers: { id: string; email: string }[];
  currentProjectId: string;
}

export interface ApprovalIntent {
  kind: 'approval' | 'rejection';
  targetAgent: string;
  targetAgentId: string;
}

export interface ParseMentionsResult {
  mentions: ResolvedMention[];
  approvalIntent: ApprovalIntent | null;
}

export function parseMentions(input: ParseMentionsInput): ParseMentionsResult {
  const { workspaceAgents, workspaceMembers, currentProjectId } = input;
  // BUG-009 — mask code/quote spans so tokenisation + keyword scanning skip
  // them entirely. Equal-length whitespace replacement preserves all offsets.
  const body = maskMarkdownNoise(input.body);

  const seen = new Set<string>();
  const mentions: ResolvedMention[] = [];

  // Track resolved-agent hits with their end-offsets so we can scan the
  // keyword window in Pass 2 without a second regex run.
  type AgentHit = { slug: string; agentId: string; endOffset: number };
  const agentHits: AgentHit[] = [];

  // Pass 1: tokenise and resolve.
  for (const match of body.matchAll(TOKEN_RE)) {
    const slug = match[1];
    if (slug === undefined) continue; // TOKEN_RE always has capture group 1; defensive.
    const endOffset = (match.index ?? 0) + match[0].length;
    const agentTarget = `agent:${slug}`;
    const userTarget = `user:${slug}`;

    // Attempt agent resolution first.
    const agent = workspaceAgents.find((a) => a.slug === slug);
    if (agent) {
      const inAllowList =
        agent.allowedProjectIds.includes('*') || agent.allowedProjectIds.includes(currentProjectId);

      if (inAllowList) {
        if (!seen.has(agentTarget)) {
          mentions.push({
            target: agentTarget,
            resolved: true,
            resolvedId: agent.id,
            resolvedType: 'agent',
          });
          seen.add(agentTarget);
        }
        // Always record the hit for approval-intent scanning (including duplicates,
        // so multi-occurrence bodies still detect intent on second occurrence).
        agentHits.push({ slug, agentId: agent.id, endOffset });
      } else {
        if (!seen.has(agentTarget)) {
          mentions.push({ target: agentTarget, resolved: false });
          seen.add(agentTarget);
        }
        // Agent exists but is not allowed in this project — no intent scanning.
      }
      continue;
    }

    // Attempt member resolution by email localpart.
    const memberMatches = workspaceMembers.filter((m) => m.email.split('@')[0] === slug);
    if (memberMatches.length === 1) {
      const m = memberMatches[0]!; // length===1 ensures defined
      const target = `user:${m.id}`;
      if (!seen.has(target)) {
        mentions.push({
          target,
          resolved: true,
          resolvedId: m.id,
          resolvedType: 'user',
        });
        seen.add(target);
      }
    } else {
      // Zero matches or ambiguous (multiple members share the same localpart).
      if (!seen.has(userTarget)) {
        mentions.push({ target: userTarget, resolved: false });
        seen.add(userTarget);
      }
    }
  }

  // Pass 2: approval-intent detection.
  // For each resolved-agent hit, inspect the first 2 whitespace-delimited tokens
  // that appear immediately after the mention. First match wins; verb form "approve"
  // is intentionally excluded (only past participle "approved" / "rejected" match).
  let approvalIntent: ApprovalIntent | null = null;

  for (const hit of agentHits) {
    const after = body.slice(hit.endOffset).trimStart();
    const nextTokens = after.split(/\s+/).slice(0, 2);

    // Position 1: keyword immediately after mention.
    const pos1 = nextTokens[0];
    if (pos1) {
      const m = pos1.match(KEYWORD_RE);
      const kw = m?.[1];
      if (kw) {
        const kind = kw.toLowerCase() === 'approved' ? 'approval' : 'rejection';
        approvalIntent = { kind, targetAgent: hit.slug, targetAgentId: hit.agentId };
      }
    }

    // Position 2: keyword only if position 1 is in POS1_ADJACENCY_ALLOW ("is", "has", "got", "just", etc.).
    // This distinguishes "@agent is approved" / "@agent has approved" (matches)
    // from "@agent looks approved" (no match).
    if (!approvalIntent && nextTokens.length === 2) {
      const pos2 = nextTokens[1];
      const pos1Raw = nextTokens[0];
      if (pos2 && pos1Raw) {
        const pos1Clean = pos1Raw.replace(/[.,!;:?]+$/, '').toLowerCase();
        if (POS1_ADJACENCY_ALLOW.has(pos1Clean)) {
          const m = pos2.match(KEYWORD_RE);
          const kw = m?.[1];
          if (kw) {
            const kind = kw.toLowerCase() === 'approved' ? 'approval' : 'rejection';
            approvalIntent = { kind, targetAgent: hit.slug, targetAgentId: hit.agentId };
          }
        }
      }
    }

    if (approvalIntent) break;
  }

  return { mentions, approvalIntent };
}
