import { describe, expect, test } from 'bun:test';
import { V1_MCP_TOOLS } from '@folio/shared';
import {
  FOLIO_SKILL_BODY,
  FOLIO_SKILL_SLUG,
  OPERATOR_PROMPT,
  OPERATOR_TOOLS,
} from './system-skills.ts';

describe('system skill + reference content', () => {
  test('the folio skill body is substantial and accurate', () => {
    expect(FOLIO_SKILL_SLUG).toBe('folio');
    expect(FOLIO_SKILL_BODY.length).toBeGreaterThan(500);
    expect(FOLIO_SKILL_BODY).toContain('folio_api');
    expect(FOLIO_SKILL_BODY).toContain('config:write');
  });
  test('the operator prompt references the folio skill + is non-empty', () => {
    expect(OPERATOR_PROMPT.length).toBeGreaterThan(200);
    expect(OPERATOR_PROMPT).toContain(FOLIO_SKILL_SLUG);
  });
  test('every operator tool is a real V1_MCP_TOOLS member', () => {
    for (const t of OPERATOR_TOOLS) expect(V1_MCP_TOOLS).toContain(t);
  });

  // T13: the operator's toolset includes the cockpit `ui` tools.
  test('the operator toolset includes the cockpit ui tools', () => {
    expect(OPERATOR_TOOLS).toContain('show_link_panel');
    expect(OPERATOR_TOOLS).toContain('ask_choice');
  });

  // T13: the prompt carries the cockpit-chat UX guidance (the operator is the
  // human-facing side of the confirm flow — UX, NOT the enforcer; the gate at
  // executeTool is the real enforcer). Assert the load-bearing behaviors are
  // named so a future prompt edit can't silently drop them.
  test('the operator prompt carries the cockpit-chat UX guidance', () => {
    // act-then-report (do the reversible work, then summarize).
    expect(OPERATOR_PROMPT.toLowerCase()).toContain('act-then-report');
    // surface a link panel after a write.
    expect(OPERATOR_PROMPT).toContain('show_link_panel');
    // a real fork → a choice card.
    expect(OPERATOR_PROMPT).toContain('ask_choice');
    // destructive ops are PROPOSED via a choice card (the confirm-via-card UX).
    expect(OPERATOR_PROMPT.toLowerCase()).toContain('confirm');
    // stay on-topic (don't drift off the operator role).
    expect(OPERATOR_PROMPT.toLowerCase()).toContain('on topic');
  });
});
