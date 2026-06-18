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
  // Regression: a named item not found in the first workspace must trigger a
  // cross-workspace widen, not a "doesn't exist" / near-match flip. (The
  // operator searched only "Demo" and missed an item in another workspace —
  // find_documents spans projects within ONE workspace, never across them.)
  // This asserts the GUIDANCE is present; the actual widen behavior is a live
  // operator-turn check (shake-out), not unit-testable.
  test('the folio skill + operator prompt teach cross-workspace widening on a miss', () => {
    expect(FOLIO_SKILL_BODY).toContain('list_workspaces');
    // the skill states find_documents does NOT span workspaces
    expect(FOLIO_SKILL_BODY.toLowerCase()).toContain('does not span workspaces');
    // both surfaces carry the "not found here ≠ doesn't exist" widen rule
    expect(OPERATOR_PROMPT.toLowerCase()).toContain('look in the others');
  });
  // Regression: the skill must teach the full Phase-6 view vocabulary so the
  // operator sets up views correctly. (It previously only knew kanban+table and
  // had a filter→filters bug that 400s.) Guards the bug fix + the view-type and
  // config-field coverage.
  test('the folio skill documents the full view vocabulary (filters plural, all 6 types, config fields)', () => {
    // the filter→filters bug must stay fixed (singular 400s)
    expect(FOLIO_SKILL_BODY).toContain('filters');
    expect(FOLIO_SKILL_BODY).toContain('$eq'); // FilterAST, not flat k/v
    // all six view types are named in the enum line (the less-common ones are
    // the real coverage signal — 'table'/'list' are common substrings, but
    // calendar/timeline/gallery only appear because the view vocab documents them)
    for (const t of ['kanban', 'calendar', 'timeline', 'gallery']) {
      expect(FOLIO_SKILL_BODY).toContain(t);
    }
    // the view-config surface that lets the operator build a real project
    expect(FOLIO_SKILL_BODY).toContain('visibleFields');
    expect(FOLIO_SKILL_BODY).toContain('groupBy');
    expect(FOLIO_SKILL_BODY).toContain('isDefault');
    expect(FOLIO_SKILL_BODY).toContain('dateField'); // calendar settings
  });
  test('every operator tool is a real V1_MCP_TOOLS member', () => {
    for (const t of OPERATOR_TOOLS) expect(V1_MCP_TOOLS).toContain(t);
  });

  // T13: the operator's toolset includes the cockpit `ui` tools.
  test('the operator toolset includes the cockpit ui tools', () => {
    expect(OPERATOR_TOOLS).toContain('show_link_panel');
    expect(OPERATOR_TOOLS).toContain('ask_choice');
  });

  // BOOTSTRAP: the operator must be able to DISCOVER a workspace from nothing.
  // Without list_workspaces (no-arg) it can only call list_projects (which
  // REQUIRES a workspace_slug it has no way to learn) → it guesses a bad slug →
  // "workspace not accessible" → the user is asked for the slug every time.
  test('the operator toolset includes list_workspaces (no-arg discovery)', () => {
    expect(OPERATOR_TOOLS).toContain('list_workspaces');
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
