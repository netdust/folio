import { test, expect, signUpFresh, createWorkspace } from './fixtures.ts';

test('cockpit auto-resumes the most-recent conversation on reload', async ({ page }) => {
  await signUpFresh(page);
  const wslug = `ar-${Date.now()}`;
  await createWorkspace(page, 'Auto Resume', wslug);
  await page.goto(`/w/${wslug}/agents`);

  // The Operator panel is default-open; its composer is visible.
  const composer = page.getByPlaceholder(/Ask the operator/i);
  await expect(composer).toBeVisible({ timeout: 6000 });

  // Send a message → creates a conversation + persists the user row (the runner
  // then fails silently, no AI key — that's fine; we only need the user message).
  await composer.fill('hello operator');
  await composer.press('Enter');
  await expect(page.getByText('hello operator')).toBeVisible({ timeout: 6000 });

  // RELOAD — the old blank-on-reload bug would show the empty greeting here.
  await page.reload();

  // The thread is RESTORED: the prior user message is visible, greeting is gone.
  await expect(page.getByText('hello operator')).toBeVisible({ timeout: 6000 });
  await expect(page.getByText('How can the operator help?')).toHaveCount(0);
});

test('cockpit shows the empty greeting for a fresh user with no conversation', async ({ page }) => {
  await signUpFresh(page);
  const wslug = `fresh-${Date.now()}`;
  await createWorkspace(page, 'Fresh', wslug);
  await page.goto(`/w/${wslug}/agents`);

  // A brand-new user has zero conversations → /recent returns { id: null } →
  // the cockpit shows the empty greeting, not a restored thread.
  await expect(page.getByText('How can the operator help?')).toBeVisible({ timeout: 6000 });
});
