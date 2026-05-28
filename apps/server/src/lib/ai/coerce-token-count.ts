/**
 * Round 7 #9 — shared coercion helper for provider-supplied token counts.
 *
 * Pre-round-7 the ollama provider had `coerceTokenCount` inlined; anthropic
 * and openai accepted `usage.input_tokens` / `usage.prompt_tokens` and the
 * `completion`/`output` variants directly without any clamp. A sloppy /
 * malformed upstream (or a proxy in the middle) could send negative,
 * fractional, non-numeric, or string-encoded values; those propagated into
 * agent_runs frontmatter (REAL column → IEEE-754 drift on SUM) and budget
 * accounting (cheap agents silently exceed budgets that should have stopped
 * them).
 *
 * Centralize the rules. Accepts:
 *   - `number` values that pass `Number.isFinite` → truncated + sign-clamped.
 *   - `string` values matching `/^\d+$/` (digits-only, non-negative) → parsed.
 *
 * Rejects (returns the `fallback`):
 *   - `null`, `undefined`, `''`, `false`, `[]`, objects, NaN.
 *   - strings that don't match the digits pattern (including '7.5', '-7', 'abc').
 *
 * The round-5 ollama regex `^-?\d+(\.\d+)?$` accepted negatives + fractions
 * and relied on `Math.max(0, Math.trunc(n))` to fix them up. Round 7
 * tightens the regex so the integer path produces a non-negative integer
 * directly; the number-path keeps the trunc + max(0) clamp since `number`
 * values still need sign + truncation defense.
 *
 * Threat model mitigation 9 + round 7 generalization.
 */
export function coerceTokenCount(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return fallback;
}
