import { test, expect, signUpFresh, createWorkspace, createProject } from './fixtures.ts';

test('sign-up + workspace + project lands you on the work-items list', async ({ page }) => {
  await signUpFresh(page);
  await createWorkspace(page, 'Acme', 'acme');
  await createProject(page, 'acme', 'Web', 'web');

  await page.goto('/w/acme/p/web/work-items');

  // Rail shows project + the workspace mark.
  await expect(page.getByRole('button', { name: /Acme/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Web/ })).toBeVisible();
});

test('rail user menu lets you sign out and lands you on /login', async ({ page }) => {
  const user = await signUpFresh(page, { name: 'Sign Out Tester' });
  await createWorkspace(page, 'SignOutWS', 'signout-ws');

  await page.goto('/w/signout-ws');

  // Open the user menu via the user chip in the bottom of the rail.
  await page.getByRole('button', { name: user.name }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();

  await expect(page).toHaveURL(/\/login/);
});

test('user menu "Create workspace" opens the sheet from inside a workspace', async ({ page }) => {
  const user = await signUpFresh(page, { name: 'Create From Inside' });
  await createWorkspace(page, 'First', 'first');

  await page.goto('/w/first');

  await page.getByRole('button', { name: user.name }).click();
  await page.getByRole('button', { name: /\+ Create workspace/ }).click();

  await expect(page.getByRole('dialog', { name: /New workspace/i })).toBeVisible();
});
