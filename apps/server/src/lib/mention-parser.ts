import type { ResolvedMention } from './comment-schema.ts';

/**
 * Matches `@<slug>` only after whitespace or at line start.
 * The leading whitespace requirement prevents matching email addresses
 * like `jan@example.com` that appear mid-text.
 */
const TOKEN_RE = /(?:^|\s)@([a-z][a-z0-9-]+)/g;

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
  workspaceAgents: { id: string; slug: string; allowedProjectIds: string[] | ['*'] }[];
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
  const { body, workspaceAgents, workspaceMembers, currentProjectId } = input;

  const seen = new Set<string>();
  const mentions: ResolvedMention[] = [];

  // Track resolved-agent hits with their end-offsets so we can scan the
  // keyword window in Pass 2 without a second regex run.
  type AgentHit = { slug: string; agentId: string; endOffset: number };
  const agentHits: AgentHit[] = [];

  // Pass 1: tokenise and resolve.
  for (const match of body.matchAll(TOKEN_RE)) {
    const slug = match[1];
    const endOffset = (match.index ?? 0) + match[0].length;
    const agentTarget = `agent:${slug}`;
    const userTarget = `user:${slug}`;

    // Attempt agent resolution first.
    const agent = workspaceAgents.find((a) => a.slug === slug);
    if (agent) {
      const inAllowList =
        agent.allowedProjectIds[0] === '*' || agent.allowedProjectIds.includes(currentProjectId);

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
      const target = `user:${memberMatches[0].id}`;
      if (!seen.has(target)) {
        mentions.push({
          target,
          resolved: true,
          resolvedId: memberMatches[0].id,
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
      if (m) {
        const kind = m[1].toLowerCase() === 'approved' ? 'approval' : 'rejection';
        approvalIntent = { kind, targetAgent: hit.slug, targetAgentId: hit.agentId };
      }
    }

    // Position 2: keyword only if position 1 is in POS1_ADJACENCY_ALLOW ("is", "has", "got", "just", etc.).
    // This distinguishes "@agent is approved" / "@agent has approved" (matches)
    // from "@agent looks approved" (no match).
    if (!approvalIntent && nextTokens.length === 2) {
      const pos2 = nextTokens[1];
      const pos1Clean = nextTokens[0].replace(/[.,!;:?]+$/, '').toLowerCase();
      if (POS1_ADJACENCY_ALLOW.has(pos1Clean)) {
        const m = pos2.match(KEYWORD_RE);
        if (m) {
          const kind = m[1].toLowerCase() === 'approved' ? 'approval' : 'rejection';
          approvalIntent = { kind, targetAgent: hit.slug, targetAgentId: hit.agentId };
        }
      }
    }

    if (approvalIntent) break;
  }

  return { mentions, approvalIntent };
}
