/**
 * E2E coverage for the 15-scenario manual QA list in
 * `apps/web/tests/manual-qa-phase-1.md`.
 *
 * Each `test('scenario N — ...')` block maps to the same-numbered scenario.
 *
 * STATUS: first pass. Scenarios 1, 2, 15 are wired and passing. Scenarios
 * 3–14 are scaffolded as `test.skip(...)` with a TODO comment per test —
 * each needs DOM-specific selector tightening against the real UI. Lift the
 * `.skip` after wiring the right selectors. The smoke tests in `smoke.spec.ts`
 * already cover the recent bug fixes (sign-out menu, create-from-inside).
 *
 * Scenarios deliberately covered by Vitest unit tests, not Playwright:
 *   - 7  (mode toggle internals): `src/components/slideover/__roundtrip__/round-trip.test.tsx`.
 *   - 14 (offline rollback): the optimistic mutation helper is unit tested;
 *     forcing a network failure in Playwright is flaky.
 */

import { test, expect, signUpFresh, createWorkspace, createProject } from './fixtures.ts';

// Use a per-test counter to avoid slug collisions in the shared e2e DB.
let testSeq = 0;
function freshSlugs() {
  testSeq += 1;
  return {
    wslug: `ws-${testSeq}-${Date.now().toString(36)}`,
    pslug: `proj-${testSeq}-${Date.now().toString(36)}`,
  };
}

async function bootstrapProject(page: import('@playwright/test').Page) {
  const user = await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `WS ${testSeq}`, wslug);
  await createProject(page, wslug, `Proj ${testSeq}`, pslug);
  return { user, wslug, pslug };
}

test('scenario 1 — onboarding: workspace create lands you in the workspace', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome to Folio/i })).toBeVisible();
  await page.getByRole('button', { name: /Create workspace/i }).click();
  const wsName = `Spring ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(wsName);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/w\/spring-/);
});

test('scenario 2 — onboarding: project create lands on work-items list', async ({ page }) => {
  await signUpFresh(page);
  const { wslug } = freshSlugs();
  await createWorkspace(page, `WS ${testSeq}`, wslug);
  await page.goto(`/w/${wslug}`);
  await page.getByRole('button', { name: /Create project/i }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Gallery Ops');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${wslug}/p/gallery-ops/work-items`));
});

test('scenario 15 — sign-up form rejects duplicate email', async ({ page }) => {
  const user = await signUpFresh(page);
  await page.request.post('/api/v1/auth/logout');
  await page.goto('/login');
  // Tabs are plain buttons (see components/ui/tabs.tsx).
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  // Login form fields use <label><span/><input/></label> with no htmlFor — fill
  // by input type instead, which is unambiguous on the Sign up tab.
  await page.locator('input[type="text"]').fill('Duplicate Tester');
  await page.locator('input[type="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill('test-password-123');
  await page.getByRole('button', { name: /Create account/i }).click();
  await expect(page.getByText(/exists/i)).toBeVisible();
});

// ----- Scenarios still requiring selector work — lift .skip after tightening. -----

test.skip('scenario 3 — list view: inline title edit persists', async () => {
  // TODO: list row's title cell is currently an InlineEdit span (not a textbox
  // until clicked). Need a stable test-id on the row + title cell.
});

test.skip('scenario 4 — list view: inline status edit persists', async () => {
  // TODO: status cell uses InlineSelect (a button with no visible name when empty).
  // Add data-testid="status-cell" on the InlineSelect trigger.
});

test.skip('scenario 5 — slideover opens via row icon and closes on Escape', async () => {
  // TODO: row's open-doc icon button needs a stable aria-label. Currently the
  // accessible name varies based on doc title which causes ambiguity.
});

test.skip('scenario 6 — slideover renders frontmatter form and body editor', async () => {
  // TODO: frontmatter form labels are rendered without proper <label htmlFor>
  // associations. Need to either add them or test by visible text adjacency.
});

test.skip('scenario 8 — markdown round-trip preserves frontmatter + body', async () => {
  // TODO: probably will pass as-is — depends on text/markdown POST being accepted
  // on the JSON-default route. Verify content negotiation in routes/documents.ts.
});

test.skip('scenario 9 — kanban: per-column + creates a doc with that status', async () => {
  // TODO: per-column button has aria-label "New work item in <status>".
  // Need to wait for the kanban grid to fully hydrate first.
});

test.skip('scenario 10 — wiki: create a page from empty state', async () => {
  // TODO: wiki empty state CTA is named "+ New page" — check exact text.
});

test.skip('scenario 11 — copy-as-MD via right-click', async () => {
  // TODO: Playwright doesn't trigger the browser's native context menu directly.
  // Need to dispatch a contextmenu event manually OR test the keyboard shortcut.
});

test.skip('scenario 12 — filter chip: status=todo filters list', async () => {
  // TODO: assertion on row visibility needs to wait for query refetch after URL
  // change. The naive `expect(not.toBeVisible)` may race.
});

test.skip('scenario 13 — Cmd-K palette opens and "New work item" creates a doc', async () => {
  // TODO: command-palette uses cmdk + Radix Dialog. The placeholder text + role
  // wiring need to be confirmed in component source.
});
