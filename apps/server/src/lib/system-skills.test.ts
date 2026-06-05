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
});
