/**
 * Round-trippable YAML frontmatter parser.
 *
 * Format:
 *   ---
 *   title: ...
 *   status: in_progress
 *   priority: high
 *   ---
 *   <markdown body>
 *
 * Anything not in the top YAML block is treated as the body.
 */

import { parse, stringify } from 'yaml';

const FRONTMATTER_REGEX = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/;

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(raw: string): ParsedDocument {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const [, yamlBlock, body = ''] = match;
  try {
    const fm = parse(yamlBlock ?? '');
    return {
      frontmatter: fm && typeof fm === 'object' ? (fm as Record<string, unknown>) : {},
      body,
    };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

export function serializeMarkdown(doc: ParsedDocument): string {
  const fmKeys = Object.keys(doc.frontmatter);
  if (fmKeys.length === 0) return doc.body;
  const yaml = stringify(doc.frontmatter).trim();
  return `---\n${yaml}\n---\n\n${doc.body}`;
}
