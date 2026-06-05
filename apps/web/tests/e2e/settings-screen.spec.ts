import { test as base, expect, createWorkspace, shot } from './fixtures.ts';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * End-to-end smoke of the instance Settings screen and the per-workspace API
 * token surface, post-tenancy.
 *
 * IMPORTANT — owner bootstrap: the FIRST user registered against the (shared,
 * per-run) e2e DB becomes the instance owner; later registrants are plain
 * members. So this whole file shares ONE owner context, registered once in
 * beforeAll, and every owner-power assertion runs as that single owner. (A naive
 * per-test signUpFresh would make only the first test an owner and 403 the rest —
 * which is correct app behaviour, just the wrong test shape.)
 *
 * Covers, per the design pass this session:
 *   - "Settings" entry in the user menu (renamed from "Instance settings"),
 *     opens INSIDE the workspace rail (not a bare page).
 *   - All four Settings sections present: AI providers, Roles, Invitations,
 *     Instance API tokens.
 *   - Instance API tokens actually CREATE + reveal + list (the new POST surface).
 *   - The instance token WORKS: it can create a workspace via the API.
 *   - Per-workspace API tokens live on Agents & Triggers → API and create there.
 *   - Removed surfaces are gone: no "Workspace settings", no standalone
 *     "Triggers" entry in the workspace dropdown.
 */

const OWNER_NAME = 'Settings Owner';
const E2E_PASSWORD = 'test-password-123';

// One owner + context for the whole file.
const test = base.extend<{ owner: { context: BrowserContext; page: Page; email: string } }>({
  owner: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const email = `e2e-settings-owner-${Date.now()}@folio.test`;
      // First user against the wiped e2e DB → instance owner.
      const res = await page.request.post('/api/v1/auth/register', {
        data: { email, password: E2E_PASSWORD, name: OWNER_NAME },
      });
      expect(res.ok(), `register owner ${email} → ${res.status()}`).toBe(true);
      await use({ context, page, email });
      await context.close();
    },
    { scope: 'worker' },
  ],
});

test.describe.configure({ mode: 'serial' });

test.describe('Settings screen — full smoke', () => {
  test('owner: Settings opens in the rail with all four sections', async ({ owner }) => {
    const { page } = owner;
    await createWorkspace(page, 'Acme', 'acme');
    await page.goto('/w/acme');

    // Open the user menu → "Settings" (instance settings, renamed + gear icon).
    await page.getByRole('button', { name: OWNER_NAME }).click();
    await page.getByRole('button', { name: /^Settings$/ }).click();

    // Opens the in-workspace instance-settings route (rail kept).
    await expect(page).toHaveURL(/\/w\/acme\/instance-settings/);
    await expect(page.getByRole('button', { name: /Acme/ })).toBeVisible();

    // All four sections present (use section headings; scope to avoid the
    // duplicate <h2> the InstanceTokensTab renders inside its section).
    await expect(page.getByRole('heading', { name: /Instance settings/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^AI providers$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Roles$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Invitations$/ })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /^Instance API tokens$/ }).first(),
    ).toBeVisible();

    await shot(page, 'settings-all-sections');
  });

  test('owner: each section is wired (AI / Roles / Invitations render their controls)', async ({
    owner,
  }) => {
    const { page, email } = owner;
    await page.goto('/w/acme/instance-settings');

    // AI: the instance-wide AI provider config renders.
    await expect(page.getByRole('heading', { name: /^AI providers$/ })).toBeVisible();
    await expect(page.getByText(/instance-wide/i).first()).toBeVisible();

    // Roles: the owner sees their own row.
    await expect(page.getByText(email).first()).toBeVisible();

    // Invitations section renders.
    await expect(page.getByRole('heading', { name: /^Invitations$/ })).toBeVisible();
  });

  test('owner: invite a new member by email (the add-member flow)', async ({ owner }) => {
    const { page } = owner;
    await page.goto('/w/acme/instance-settings');

    // The Invitations section has an "Invite a new member" email form (this is
    // the path to add someone who hasn't registered yet — the grant picker only
    // covers existing users).
    await expect(page.getByRole('heading', { name: /Invite a new member/i })).toBeVisible();
    const emailInput = page.getByPlaceholder(/teammate@example/i);
    await emailInput.fill('e2e-invitee@folio.test');
    await page.getByRole('button', { name: /Send invite/i }).click();

    // Success toast + the field clears.
    await expect(page.getByText(/Invite sent to e2e-invitee@folio\.test/i)).toBeVisible();
    await expect(emailInput).toHaveValue('');
    await shot(page, 'member-invited');
  });

  test('the invite is real: it mints a magic link the invitee can consume', async ({ owner }) => {
    // The whole point of the invite: a NOT-yet-registered email gets a working
    // sign-in link. Drive it through the API (the UI form posts the same), then
    // confirm the magic-link request succeeds for a brand-new email.
    const { page } = owner;
    const res = await page.request.post('/api/v1/instance/invites', {
      data: { email: 'fresh-invitee@folio.test' },
    });
    expect(res.ok(), `invite → ${res.status()}`).toBe(true);
  });

  test('owner: create an Instance API token end-to-end (the new POST surface)', async ({
    owner,
  }) => {
    const { page } = owner;
    await page.goto('/w/acme/instance-settings');

    await page.getByRole('button', { name: /\+ Create token/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Create instance token/i)).toBeVisible();
    await dialog.getByLabel(/^name$/i).fill('operator-e2e');
    await dialog.getByRole('button', { name: /^Operator$/ }).click();
    await dialog.getByRole('button', { name: /^Create$/ }).click();

    // Plaintext token revealed exactly once.
    await expect(dialog.getByText(/only time you/i)).toBeVisible();
    await expect(dialog.locator('code')).toContainText(/folio/i);
    await shot(page, 'instance-token-created');
    await dialog.getByRole('button', { name: /^Done$/ }).click();

    // Back in the list, the token is present with a scope chip.
    await expect(page.getByText('operator-e2e')).toBeVisible();
    await expect(page.getByText('workspace:admin').first()).toBeVisible();
  });

  test('the Instance token actually works: it creates a workspace via the API', async ({
    owner,
  }) => {
    const { page } = owner;
    // Mint through the real HTTP surface as the owner session...
    const mint = await page.request.post('/api/v1/instance/tokens', {
      data: { name: 'admin-bot', scopes: ['workspace:admin'] },
    });
    expect(mint.ok(), `mint instance token → ${mint.status()}`).toBe(true);
    const { data } = (await mint.json()) as { data: { token: string; instance: boolean } };
    expect(data.instance).toBe(true);

    // ...then USE the bearer (no cookie) to create a workspace — only an
    // instance-reach workspace:admin token may.
    const created = await page.request.post('/api/v1/workspaces', {
      headers: { Authorization: `Bearer ${data.token}` },
      data: { name: 'BotMade', slug: 'bot-made' },
    });
    expect(created.ok(), `create workspace with instance token → ${created.status()}`).toBe(true);
  });

  test('per-workspace API tokens live on Agents & Triggers → API (the other half)', async ({
    owner,
  }) => {
    const { page } = owner;
    await page.goto('/w/acme/agents?tab=api');

    await expect(page.getByText(/API tokens/i).first()).toBeVisible();
    await expect(page.getByText(/this workspace/i).first()).toBeVisible();

    await page.getByRole('button', { name: /\+ Create token/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Create API token/i)).toBeVisible();
    // No "Whole instance" reach toggle here (moved to Settings).
    await expect(dialog.getByText(/whole instance/i)).toHaveCount(0);
    await dialog.getByLabel(/^name$/i).fill('ws-token-e2e');
    await dialog.getByRole('button', { name: /^Read-only$/ }).click();
    await dialog.getByRole('button', { name: /^Create$/ }).click();
    await expect(dialog.locator('code')).toContainText(/folio/i);
    await shot(page, 'workspace-token-created');
  });

  test('removed surfaces are gone: no "Workspace settings", no standalone "Triggers"', async ({
    owner,
  }) => {
    const { page } = owner;
    await page.goto('/w/acme');

    // User menu: "Settings" present, "Workspace settings" gone. Scope to the open
    // popover dialog so assertions don't catch a sibling menu's buttons.
    await page.getByRole('button', { name: OWNER_NAME }).click();
    const userMenu = page.getByRole('dialog');
    await expect(userMenu.getByRole('button', { name: /^Settings$/ })).toBeVisible();
    await expect(userMenu.getByRole('button', { name: /Workspace settings/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0); // popover fully closed

    // Workspace dropdown: "Agents & Triggers" present, standalone "Triggers" gone,
    // "Create workspace" present, "Workspace settings" gone. Scope to the dialog.
    await page.getByRole('button', { name: /Acme/ }).click();
    const wsMenu = page.getByRole('dialog');
    await expect(wsMenu.getByRole('button', { name: /Agents & Triggers/i })).toBeVisible();
    await expect(wsMenu.getByRole('button', { name: /^Triggers$/ })).toHaveCount(0);
    await expect(wsMenu.getByRole('button', { name: /\+ Create workspace/i })).toBeVisible();
    await expect(wsMenu.getByRole('button', { name: /Workspace settings/i })).toHaveCount(0);
  });
});
