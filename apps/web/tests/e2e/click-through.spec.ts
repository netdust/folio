/**
 * Click-through e2e — exercises the app via clicks ONLY. No API shortcuts.
 *
 * This is the spec to add scenarios to when something gets broken in the
 * real user journey. Each `test()` covers a discrete journey from a fresh
 * sign-up through some user-visible affordance, asserting behavior the way
 * a real user would observe it.
 *
 * Regression coverage notes (bugs found during manual exploration on
 * 2026-05-23 — see memory/lessons.md):
 *  - "title corruption when creating a doc from kanban" — covered by
 *    "kanban + per-column create + inline title edit persists".
 *  - "duplicate Create workspace button" — covered by "sign up → create
 *    workspace via sheet".
 *  - "sign out from rail" — covered by "rail user menu sign out".
 *  - "create workspace from inside a workspace" — covered by "create
 *    second workspace via user menu".
 */

import { test, expect, type Page } from '@playwright/test';

let seq = 0;
function freshEmail() {
  seq += 1;
  return `click-${Date.now()}-${seq}@folio.test`;
}

async function signUpThroughUI(page: Page, name: string): Promise<string> {
  const email = freshEmail();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.locator('input[type="text"]').fill(name);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('click-password-1');
  await page.getByRole('button', { name: /Create account/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: /Welcome to Folio/i })).toBeVisible();
  return email;
}

async function createWorkspaceViaSheet(page: Page, name: string): Promise<void> {
  // The Sheet primitive renders as role="dialog" — but so do Radix Popovers.
  // Scope by the Sheet's unique heading ("New workspace") so user-menu open/close
  // transitions don't race the locator.
  const sheet = page.getByRole('dialog', { name: 'New workspace' });
  await sheet.waitFor({ state: 'visible' });
  await page.locator('#ws-name').fill(name);
  await sheet.getByRole('button', { name: 'Create', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
}

async function createProjectViaSheet(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /Create project/i }).click();
  const sheet = page.getByRole('dialog', { name: 'New project' });
  await sheet.waitFor({ state: 'visible' });
  await page.locator('#proj-name').fill(name);
  await sheet.getByRole('button', { name: 'Create', exact: true }).click();
  await sheet.waitFor({ state: 'hidden' });
}

test('sign up → create workspace → create project → land on work-items', async ({ page }) => {
  await signUpThroughUI(page, 'Click User');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await createWorkspaceViaSheet(page, `Click WS ${Date.now()}`);
  await expect(page).toHaveURL(/\/w\/click-ws-/);

  await createProjectViaSheet(page, `Click Proj ${Date.now()}`);
  await expect(page).toHaveURL(/\/w\/click-ws-[^/]+\/p\/click-proj-[^/]+\/work-items/);
  // Three frame tabs visible.
  await expect(page.getByRole('button', { name: 'Work items', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Board', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wiki', exact: true })).toBeVisible();
});

test('kanban + per-column create + inline title edit persists (regression: no UntitledX corruption)', async ({ page }) => {
  await signUpThroughUI(page, 'Kanban User');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await createWorkspaceViaSheet(page, `Kanban WS ${Date.now()}`);
  await createProjectViaSheet(page, `Kanban Proj ${Date.now()}`);

  // Switch to Board tab and create a card under Todo.
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'New work item in Todo' }).click();
  // Slideover opens with the title input focused and the doc title set to
  // 'Untitled' in the DB. The InlineEdit MUST render the input empty (with
  // "Untitled" as the placeholder) so typing replaces rather than appends.
  const titleInput = page.locator('[role="dialog"] input[type="text"]').first();
  await expect(titleInput).toHaveValue('');
  await expect(titleInput).toHaveAttribute('placeholder', 'Untitled');
  await titleInput.fill('Real card title');
  await titleInput.press('Enter');
  await page.keyboard.press('Escape');

  // Card on board reads exactly "Real card title", NOT "UntitledReal card title".
  const card = page.locator('[role="button"][aria-roledescription="draggable"]').filter({ hasText: 'Real card title' });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('Untitled');
});

test('rail user menu — sign out goes to /login', async ({ page }) => {
  await signUpThroughUI(page, 'Sign Out User');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await createWorkspaceViaSheet(page, `SO WS ${Date.now()}`);

  // The rail's user chip name = display name.
  await page.getByRole('button', { name: 'Sign Out User' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('create second workspace via user menu from inside a workspace', async ({ page }) => {
  await signUpThroughUI(page, 'Multi WS User');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await createWorkspaceViaSheet(page, `First WS ${Date.now()}`);

  // From inside the workspace, open the user menu and create another.
  await page.getByRole('button', { name: 'Multi WS User' }).click();
  await page.getByRole('button', { name: /\+ Create workspace/ }).click();
  await createWorkspaceViaSheet(page, `Second WS ${Date.now()}`);
  await expect(page).toHaveURL(/\/w\/second-ws-/);
});

test('list rows have unique accessible names per doc (regression: a11y duplicates)', async ({ page }) => {
  await signUpThroughUI(page, 'A11y User');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await createWorkspaceViaSheet(page, `A11y WS ${Date.now()}`);
  await createProjectViaSheet(page, `A11y Proj ${Date.now()}`);

  // Create two docs from the board so the list has multiple rows.
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  for (const t of ['Alpha task', 'Beta task']) {
    await page.getByRole('button', { name: 'New work item in Backlog' }).click();
    await page.locator('[role="dialog"] input[type="text"]').first().fill(t);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
  }

  await page.getByRole('button', { name: 'Work items', exact: true }).click();

  // Each row's "Open …" button interpolates the doc title; same for the
  // inline-edit title input's aria-label. Before the fix every row carried
  // the generic name "Open document" / "Document title".
  await expect(page.getByRole('button', { name: 'Open Alpha task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Beta task' })).toBeVisible();
});

test('wiki: new page + title edit shows in tree without a reload (regression)', async ({ page }) => {
  await signUpThroughUI(page, 'Wiki User');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await createWorkspaceViaSheet(page, `Wiki WS ${Date.now()}`);
  await createProjectViaSheet(page, `Wiki Proj ${Date.now()}`);

  await page.getByRole('button', { name: 'Wiki', exact: true }).click();
  // Empty state CTA name was renamed to disambiguate from the MainFrame
  // action button (both used to be "New page" — collision).
  await page.getByRole('button', { name: /Create your first page/ }).click();
  await page.locator('[role="dialog"] input[type="text"]').first().fill('Hello Wiki');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');

  // The wiki tree must reflect the new page title without a page reload.
  // Bug A (2026-05-23): patch invalidations only matched the slideover's
  // listParams shape, leaving the wiki tree's different-params query stale.
  await expect(page.getByText('Hello Wiki')).toBeVisible();
});
