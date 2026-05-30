/**
 * Phase 3 (Sub-phase F) — provider-degraded banner.
 *
 * GOAL (when runnable): assert the workspace provider-health banner appears
 * after N consecutive provider failures (FOLIO_PROVIDER_DEGRADE_THRESHOLD,
 * default 3) and clears on the first successful run (SSE
 * `workspace.provider.recovered`).
 *
 * --- DECISION: skip-gated, no server stub built (out of scope for F) ---
 * Driving the banner deterministically requires forcing the provider to fail
 * N times in a row WITHOUT a real (and flaky/costly) bad upstream. The only
 * provider override hook in the server is:
 *
 *     apps/server/src/lib/ai/provider.ts → provider.__INTERNAL_TEST_ONLY__
 *
 * which is an IN-PROCESS registry stub guarded by `NODE_ENV === 'test'` and
 * throws otherwise. The e2e stack runs the API as a SEPARATE
 * `bun run --hot src/index.ts` process (NODE_ENV=development per
 * playwright.config.ts) over HTTP — there is no shared module graph to stub
 * and no test-only endpoint to inject provider-health from the outside. There
 * is no `FOLIO_FAKE_PROVIDER` (or equivalent) env flag in env.ts.
 *
 * Building such a hook is SERVER PRODUCTION CODE and is out of scope for this
 * doc/spec task (F is test scaffolding only). So this spec is intentionally
 * inert. To make it runnable, one of these server-side hooks must land first:
 *
 *   (a) an env-gated provider stub the e2e API process honors, e.g.
 *       FOLIO_FAKE_PROVIDER=anthropic:fail (always-error) so real failing runs
 *       trip checkProviderHealth → emit `workspace.provider.degraded`; then
 *       FOLIO_FAKE_PROVIDER=anthropic:ok to recover; OR
 *   (b) a test-only admin endpoint to inject provider-health state directly
 *       (e.g. POST /api/v1/admin/_test/provider-health), gated to NODE_ENV=test.
 *
 * Manual coverage of this surface exists in
 * apps/web/tests/manual-qa-phase-3.md (Surface 6): point the workspace key at
 * an unreachable/invalid endpoint and let real runs fail.
 *
 * The intended assertions (kept here as a runnable skeleton for whoever adds
 * the hook) live below behind the skip.
 */
import { test, expect, signUpFresh, createWorkspace, createProject } from './fixtures.ts';

test.skip(true, 'needs a server-side provider stub hook — see F-3 note at the top of this file');

test('provider-degraded banner appears on repeated failures and clears on recovery', async ({
  page,
}) => {
  await signUpFresh(page);
  await createWorkspace(page, 'Provider Banner', 'pbanner');
  await createProject(page, 'pbanner', 'Inbox', 'inbox');

  await page.goto('/w/pbanner');

  // --- With the hook in place, force ≥ FOLIO_PROVIDER_DEGRADE_THRESHOLD (3)
  // failing Anthropic runs here (assign-an-agent loop, or the future test-only
  // health-injection endpoint). Then: ---

  // The warning banner is role="alert" and names the degraded provider.
  const banner = page.getByRole('alert').filter({ hasText: /provider.*degraded/i });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText(/anthropic/i);
  // It offers a "Check key →" deep-link to the AI settings tab.
  await expect(banner.getByRole('button', { name: /Check key/ })).toBeVisible();

  // --- Then recover the provider (one successful run / flip the stub to ok). ---

  // The banner clears on SSE workspace.provider.recovered.
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
});
