#!/usr/bin/env bun
/**
 * check-invariants.ts — traceability check for ARCHITECTURE-INVARIANTS.md.
 *
 * Verifies that every convergence point named in the doc still POINTS AT REAL
 * CODE: the cited source file exists, the symbols named alongside it are still
 * defined there, and any embedded `:NN` line number is still roughly accurate.
 * It does NOT verify the property HOLDS (that needs dataflow analysis / the
 * invariant-auditor agent) — only that the doc hasn't drifted off its anchors.
 *
 * WHAT IT CHECKS (the reliable contract):
 *   A "citation" is a backticked path token containing a source file
 *   (`…/foo.ts` or `foo.ts`, optionally `:NN`), plus the backticked
 *   identifier tokens that appear in the SAME `Converges on` clause and look
 *   like real exported symbols (camelCase / PascalCase / UPPER_SNAKE — NOT
 *   snake_case table names, NOT literals like `null`/`high`, NOT route paths).
 *   For each such file we confirm it exists; for each symbol we confirm it is
 *   DEFINED in at least one cited file; for each `:NN` we confirm the line
 *   still matches. Prose backticks (headers, table names, literals, history)
 *   are deliberately ignored — distinguishing those from citations is the
 *   human/LLM auditor's job, not this script's.
 *
 * Two failure classes:
 *   ERROR (exit 1) — a cited source file is missing, or a cited symbol is no
 *                    longer defined in any cited file. Navigation breaks.
 *   WARN  (exit 0) — an embedded `:NN` line number no longer matches reality.
 *                    Line numbers are volatile; nudge a refresh, don't fail CI.
 *
 * Usage:
 *   bun run scripts/check-invariants.ts            # report
 *   bun run scripts/check-invariants.ts --strict   # line drift also fails (exit 1)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
// INVARIANTS_DOC overrides the doc path (used by the self-test).
const DOC = process.env.INVARIANTS_DOC
  ? resolve(process.env.INVARIANTS_DOC)
  : resolve(ROOT, 'ARCHITECTURE-INVARIANTS.md');
const STRICT = process.argv.includes('--strict');

type Finding = { invariant: string; level: 'error' | 'warn'; message: string };

// The doc abbreviates paths; resolve against the known source roots.
const SOURCE_ROOTS = ['', 'apps/server/src/', 'apps/web/src/', 'packages/shared/src/'];

/** A backtick token is a CODE-FILE citation iff it ends in a source extension
 *  (optionally with a `:NN` / `:NN-MM` suffix). This is what excludes route
 *  paths (`/events`, `tools/call`) and doc paths (`tasks/retro-follow-ups.md`). */
function isCodeFileToken(t: string): boolean {
  return /\.(ts|tsx)(:\d+(-\d+)?)?$/.test(t);
}

/** A backtick token is a verifiable SYMBOL iff it's a single identifier that
 *  looks like an exported binding: has an uppercase letter or is UPPER_SNAKE.
 *  Excludes snake_case table/column names (`workspace_access`, `pending_ops`),
 *  bare lowercase literals (`null`, `high`, `low`, `fetch`, `trusted`), and
 *  anything with punctuation. We err toward NOT checking — a missed symbol is
 *  the auditor's job; a false ERROR erodes trust in the script. */
function isVerifiableSymbol(t: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) return false;
  const hasUpper = /[A-Z]/.test(t);
  const isUpperSnake = /^[A-Z0-9_]+$/.test(t);
  return hasUpper || isUpperSnake;
}

function resolveCitedPath(token: string): string | null {
  const bare = token.replace(/:\d+(?:-\d+)?$/, '');
  for (const r of SOURCE_ROOTS) {
    const candidate = resolve(ROOT, r + bare);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function citedLine(token: string): number | null {
  const m = token.match(/:(\d+)(?:-\d+)?$/);
  return m ? Number(m[1]) : null;
}

/** 1-based line where `symbol` is DEFINED, or null. Broad but definition-shaped. */
function findSymbolLine(fileContent: string, symbol: string): number | null {
  const lines = fileContent.split('\n');
  const sym = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defPatterns = [
    new RegExp(`\\b(export\\s+)?(async\\s+)?function\\s+${sym}\\b`),
    new RegExp(`\\b(export\\s+)?(const|let|class|type|interface|enum)\\s+${sym}\\b`),
    new RegExp(`^\\s*${sym}\\s*[:(=]`), // object-literal / method shorthand
  ];
  for (let i = 0; i < lines.length; i++) {
    if (defPatterns.some((p) => p.test(lines[i]))) return i + 1;
  }
  return null;
}

function main(): number {
  if (!existsSync(DOC)) {
    console.error(`ARCHITECTURE-INVARIANTS.md not found at ${DOC}`);
    return 1;
  }
  const text = readFileSync(DOC, 'utf8');
  const lines = text.split('\n');

  const findings: Finding[] = [];
  let filesChecked = 0;
  let symbolsChecked = 0;
  let invariantsSeen = 0;

  // Only scan the enforced-invariants section; stop at "## Open".
  let inInvariants = false;

  for (const raw of lines) {
    if (/^##\s+Invariants/.test(raw)) {
      inInvariants = true;
      continue;
    }
    if (/^##\s+Open\b/.test(raw)) break;
    if (!inInvariants) continue;

    const idMatch = raw.match(/^(\d+[a-z]?)\.\s+\*\*/);
    if (!idMatch) continue;
    const invId = idMatch[1];
    invariantsSeen++;

    const convIdx = raw.indexOf('Converges on');
    if (convIdx === -1) {
      findings.push({
        invariant: invId,
        level: 'error',
        message: 'no "Converges on" clause found',
      });
      continue;
    }

    // Citations live between "Converges on" and the end of that sentence.
    // Cut at the first " — " or ". " that ends the clause to avoid pulling in
    // the bug-description prose that follows (which is full of literals).
    const tail = raw.slice(convIdx);
    const stop = tail.search(/\.\s|\s—\s/);
    const clause = stop === -1 ? tail : tail.slice(0, stop);

    const tokens = [...clause.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const fileTokens = tokens.filter(isCodeFileToken);
    const symbolTokens = tokens.filter((t) => !isCodeFileToken(t) && isVerifiableSymbol(t));

    if (fileTokens.length === 0) {
      findings.push({
        invariant: invId,
        level: 'error',
        message: 'no source-file citation in "Converges on" clause',
      });
      continue;
    }

    const resolvedFiles: { token: string; path: string; content: string }[] = [];
    for (const ft of fileTokens) {
      const resolved = resolveCitedPath(ft);
      filesChecked++;
      if (!resolved) {
        findings.push({
          invariant: invId,
          level: 'error',
          message: `cited file not found: \`${ft}\``,
        });
        continue;
      }
      resolvedFiles.push({ token: ft, path: resolved, content: readFileSync(resolved, 'utf8') });
    }
    if (resolvedFiles.length === 0) continue;

    for (const sym of symbolTokens) {
      let foundIn: { path: string; line: number } | null = null;
      for (const rf of resolvedFiles) {
        const line = findSymbolLine(rf.content, sym);
        if (line !== null) {
          foundIn = { path: rf.path, line };
          break;
        }
      }
      symbolsChecked++;
      if (!foundIn) {
        findings.push({
          invariant: invId,
          level: 'error',
          message: `cited symbol \`${sym}\` not defined in any cited file (${fileTokens.join(', ')})`,
        });
        continue;
      }
      const at = foundIn; // narrowed; const keeps the narrowing inside the closure
      const owning = fileTokens.find(
        (ft) => resolveCitedPath(ft) === at.path && citedLine(ft) !== null,
      );
      const cited = owning ? citedLine(owning) : null;
      if (owning && cited !== null) {
        if (Math.abs(cited - at.line) > 2) {
          findings.push({
            invariant: invId,
            level: 'warn',
            message: `line drift — doc cites \`${owning}\` but \`${sym}\` is at line ${at.line}`,
          });
        }
      }
    }
  }

  for (const f of findings) {
    console.log(`[${f.level === 'error' ? 'ERROR' : 'WARN '}] inv ${f.invariant}: ${f.message}`);
  }

  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  console.log('');
  console.log(
    `${invariantsSeen} invariant(s); ${filesChecked} file + ${symbolsChecked} symbol citation(s) checked: ` +
      `${errors.length} error(s), ${warns.length} warning(s).`,
  );

  if (errors.length > 0) return 1;
  if (STRICT && warns.length > 0) return 1;
  return 0;
}

process.exit(main());
