import { test, expect, type Page } from '@playwright/test';
import { signUpFresh, createWorkspace, createProject } from './fixtures.ts';

/**
 * Feature-acceptance for view-reorder (Item A, plan 2026-06-08-view-reorder-and-
 * pending-ops-reaper). Drives the rail "Move up"/"Move down" menu through the REAL
 * browser against the Playwright-managed dev stack — the round-trip (menu → PATCH
 * order → rail re-sort) that jsdom unit tests cannot exercise. The pure menu logic
 * (which items appear, the args passed) is covered by rail-tree.test.ts; this proves
 * the wired feature actually reorders and persists.
 *
 * Acceptance matrix (from the plan):
 *   A1 — Move down                A2 — Move up
 *   A3 — persists across reload   + boundary edges (first/last disabled items)
 */

let seq = 0;
function freshSlugs() {
  seq += 1;
  return { wslug: `vr-ws-${Date.now()}-${seq}`, pslug: `vr-p-${seq}` };
}

/** Create a List view named `name` via the New-view sheet. Lands on /work-items. */
async function createListView(page: Page, name: string) {
  await page.getByRole('button', { name: /New view/i }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(/New view/i).first()).toBeVisible();
  await sheet.locator('#view-name').fill(name);
  // List is the default type; create directly.
  await sheet.getByRole('button', { name: /^Create/i }).click();
  await expect(sheet).toBeHidden({ timeout: 6000 });
}

/** Open a rail row's "More actions" (…) menu by the row's exact label. The row is
 *  the immediate `div.group/row` that holds the item button + its menu (NOT the
 *  enclosing <li>, which also contains descendant rows). */
async function openRowMenu(page: Page, label: string) {
  const item = page.getByTestId('rail-tree-item').filter({ hasText: new RegExp(`^${label}$`) });
  const row = item.locator('xpath=ancestor::div[contains(@class,"group/row")][1]');
  await row.hover(); // the … button is opacity-0 until row hover
  await row.getByTestId('rail-tree-menu').click();
}

/** Read the persisted views (wire truth) sorted by `order`, returning names. */
async function persistedViewNames(page: Page, wslug: string, pslug: string): Promise<string[]> {
  const res = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/views`);
  const views = ((await res.json()).data ?? []) as Array<{ name: string; order: number }>;
  return [...views].sort((a, b) => a.order - b.order).map((v) => v.name);
}

test('A1+A3: Move down reorders a view and persists across reload', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `VR ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);

  // Seeded default view + two new ones → at least 3 views to reorder.
  await createListView(page, 'Alpha');
  await createListView(page, 'Beta');

  const before = await persistedViewNames(page, wslug, pslug);
  // Alpha precedes Beta (created first → lower order).
  expect(before.indexOf('Alpha')).toBeLessThan(before.indexOf('Beta'));

  // Move Alpha DOWN one slot → it should now sort after Beta.
  await openRowMenu(page, 'Alpha');
  await page.getByRole('menuitem', { name: 'Move down' }).click();

  await expect(async () => {
    const after = await persistedViewNames(page, wslug, pslug);
    expect(after.indexOf('Alpha')).toBeGreaterThan(after.indexOf('Beta'));
  }).toPass({ timeout: 6000 });

  // A3: persists across a full reload, reflected in the RAIL DOM (the user-visible
  // outcome — not just the API). Compare the on-screen vertical positions of the
  // two view rows by their bounding-box y.
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  await expect(async () => {
    const alphaBox = await page
      .getByTestId('rail-tree-item')
      .filter({ hasText: /^Alpha$/ })
      .boundingBox();
    const betaBox = await page
      .getByTestId('rail-tree-item')
      .filter({ hasText: /^Beta$/ })
      .boundingBox();
    expect(alphaBox, 'Alpha row visible').not.toBeNull();
    expect(betaBox, 'Beta row visible').not.toBeNull();
    // Alpha was moved DOWN, so it renders BELOW Beta (larger y).
    expect(alphaBox!.y).toBeGreaterThan(betaBox!.y);
  }).toPass({ timeout: 6000 });
});

test('A2: Move up reorders a view (correct direction, the bug the review caught)', async ({
  page,
}) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `VR ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);

  await createListView(page, 'Gamma');
  await createListView(page, 'Delta');

  const before = await persistedViewNames(page, wslug, pslug);
  expect(before.indexOf('Gamma')).toBeLessThan(before.indexOf('Delta'));

  // Move Delta UP one slot → it should now sort before Gamma. (The /code-review bug
  // was Move-up moving the WRONG direction; this proves the direction-aware fix.)
  await openRowMenu(page, 'Delta');
  await page.getByRole('menuitem', { name: 'Move up' }).click();

  await expect(async () => {
    const after = await persistedViewNames(page, wslug, pslug);
    expect(after.indexOf('Delta')).toBeLessThan(after.indexOf('Gamma'));
  }).toPass({ timeout: 6000 });
});

test('boundary: first view has no Move up, last view has no Move down', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `VR ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);

  await createListView(page, 'Epsilon');

  // Use wire truth (views sorted by order) for the first/last VIEW names — the rail
  // also renders project/table/wiki rows, so DOM position 0 isn't the first view.
  const views = await persistedViewNames(page, wslug, pslug);
  const first = views[0];
  const last = views[views.length - 1];
  expect(first).not.toBe(last); // ≥2 views (seeded default + Epsilon)

  // First view: Move up absent, Move down present.
  await openRowMenu(page, first);
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Last view: Move down absent, Move up present.
  await openRowMenu(page, last);
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toHaveCount(0);
});
