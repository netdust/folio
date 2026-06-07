import { test, expect } from '@playwright/test';
import { signUpFresh, createWorkspace, createProject } from './fixtures.ts';

/**
 * Feature-acceptance for the hardening pass (spec/hardening-pass) — drives the
 * NEW user-facing flows through the real browser against the Playwright-managed
 * dev stack. Backend flows (token expiry → 401, /ai/complete denials + read-only,
 * project.deleted SSE delivery) are covered through the un-mocked mounted-app
 * route tests; this spec is the UI half.
 *
 * NOT driven here (recorded as residual in the shake-out manifest, not green):
 *   - AI slash commands against a REAL provider (/draft, /decompose, /summarize):
 *     need a real BYOK key → unverified-no-browser (user's smoke gate). The
 *     PARSE half of /draft (markdown → real ProseMirror nodes, the root-cause
 *     fix) IS driven below with /me + /ai/complete route-stubbed — no key needed.
 *   - Board manual drag-reorder (4c): headless dnd-kit pointer drag is fragile
 *     (the existing shakeout-projects spec records the same) → human eyeball.
 */

let seq = 0;
function freshSlugs() {
  seq += 1;
  return { wslug: `hp-ws-${Date.now()}-${seq}`, pslug: `hp-p-${seq}` };
}

// ── Token lifecycle UI (Cluster 1) ────────────────────────────────────────────

test('token: create with an expiry → persists with a non-null expiresAt', async ({ page }) => {
  await signUpFresh(page);
  const { wslug } = freshSlugs();
  // Capture the workspace id from the create response.
  const wsRes = await page.request.post('/api/v1/workspaces', {
    data: { name: `HP ${seq}`, slug: wslug },
  });
  expect(wsRes.ok()).toBe(true);
  const wsId = ((await wsRes.json()) as { data: { id: string } }).data.id;

  // Per-workspace API tokens live on the automation page's API tab (?tab=api).
  await page.goto(`/w/${wslug}/agents?tab=api`);
  await page.getByRole('button', { name: /\+ Create token/i }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="text"]').first().fill('CI token');
  // Expiry: the number input with the "never expire" placeholder.
  await dialog.locator('input[type="number"]').fill('30');
  // Pick a scope preset so the form is submittable (Create is disabled w/o scopes).
  await dialog.getByRole('button', { name: /Read-only/i }).first().click();
  await dialog.getByRole('button', { name: /^Create/i }).click();

  // Wire truth: the token persisted WITH an expiry.
  await expect(async () => {
    const listRes = await page.request.get(`/api/v1/w/${wslug}/tokens/${wsId}`);
    // jsonOk wraps as { data: { tokens: [...] } }.
    const tokens = (((await listRes.json()).data?.tokens ?? []) as Array<{
      name: string;
      expiresAt: string | null;
    }>);
    const ci = tokens.find((t) => t.name === 'CI token');
    expect(ci, 'CI token should exist').toBeDefined();
    expect(ci!.expiresAt, 'created token should carry an expiry').not.toBeNull();
  }).toPass({ timeout: 6000 });
});

test('token: a decimal expiry is rejected client-side (no opaque 400)', async ({ page }) => {
  await signUpFresh(page);
  const { wslug } = freshSlugs();
  await createWorkspace(page, `HP ${seq}`, wslug);
  await page.goto(`/w/${wslug}/agents?tab=api`);
  await page.getByRole('button', { name: /\+ Create token/i }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="text"]').first().fill('Decimal token');
  await dialog.locator('input[type="number"]').fill('3.5');
  await dialog.getByRole('button', { name: /read/i }).first().click();

  // The inline alert appears AND Create is disabled — the client guards the
  // non-integer instead of sending a request the server would 400.
  await expect(dialog.getByRole('alert')).toContainText(/whole number/i);
  await expect(dialog.getByRole('button', { name: /^Create/i })).toBeDisabled();
});

// ── Views are real (Cluster 4) ────────────────────────────────────────────────

test('view: create a Kanban view from the New-view sheet → lands on the board', async ({
  page,
}) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `HP ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);

  // The rail exposes a "New view" + control on the table row.
  await page.getByRole('button', { name: /New view/i }).first().click();

  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(/New view/i).first()).toBeVisible();
  await sheet.locator('#view-name').fill('My board');

  // The NEW type selector — pick Kanban.
  await sheet.getByRole('radio', { name: /kanban/i }).click();
  await sheet.getByRole('button', { name: /^Create/i }).click();

  // A kanban view navigates to /board.
  await expect(page).toHaveURL(/\/board(\?|$)/, { timeout: 6000 });

  // Wire truth: the created view persisted as type=kanban.
  await expect(async () => {
    const res = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/views`);
    const views = ((await res.json()).data ?? []) as Array<{ name: string; type: string }>;
    const v = views.find((x) => x.name === 'My board');
    expect(v, 'My board view should exist').toBeDefined();
    expect(v!.type).toBe('kanban');
  }).toPass({ timeout: 6000 });
});

test('board: changing group-by on the default board persists across a reload', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `HP ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);

  // Open the seeded board directly (no ?view= → the default board, the path 4b fixes).
  await page.goto(`/w/${wslug}/p/${pslug}/board`);
  await expect(page.getByRole('button', { name: /Group:/i })).toBeVisible({ timeout: 6000 });

  // Change the group-by away from the default (Status → Priority, a seeded field).
  await page.getByRole('button', { name: /Group:/i }).click();
  const priorityOption = page.getByRole('menuitem', { name: /priority/i }).first();
  if ((await priorityOption.count()) === 0) {
    test.skip(true, 'no non-status groupable field seeded; persistence path identical');
  }
  await priorityOption.click();

  // Reload — 4b means the change persisted to the default view, so it survives.
  await page.reload();
  await expect(page.getByRole('button', { name: /Group:\s*Priority/i })).toBeVisible({
    timeout: 6000,
  });
});

// ── AI slash result PARSES as markdown (root-cause fix, this bugfix) ───────────
//
// The slash-insert path used to poke the AI's raw markdown string into a single
// ProseMirror text node (`#` stayed literal, `\n` collapsed). The fix routes the
// result through the editor's `replaceRange` action, which PARSES it. jsdom
// can't render a real ProseMirror tree, so this is the only place the parse is
// provable. We stub /me (→ ai_configured) and /ai/complete (→ markdown) so no
// real BYOK key is needed; the assertion is a REAL <h1> in the editor DOM, not
// a literal "#".
test('slash /draft: AI result renders as a real H1 + list, not literal markdown', async ({
  page,
}) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `HP ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);

  // Stub the boot identity so the AI slash commands are enabled WITHOUT a key.
  await page.route('**/api/v1/auth/me', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as { data?: Record<string, unknown> };
    await route.fulfill({
      response: res,
      json: { ...json, data: { ...(json.data ?? {}), ai_configured: true } },
    });
  });
  // Stub the AI completion: multi-block markdown that MUST parse (H1 + list).
  const aiMarkdown = '# Drafted Heading\n\nA paragraph.\n\n- first\n- second';
  await page.route('**/api/v1/w/*/ai/complete', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { text: aiMarkdown } }),
    });
  });

  // Seed an EMPTY work item so the editor starts blank, then open it.
  const create = await page.request.post(
    `/api/v1/w/${wslug}/p/${pslug}/documents`,
    { data: { type: 'work_item', title: 'Draft me', body: '' } },
  );
  expect(create.ok(), `seed ${create.status()}: ${await create.text()}`).toBe(true);
  const slug = (await create.json()).data.slug as string;

  await page.goto(`/w/${wslug}/p/${pslug}/work-items?doc=${slug}`);
  const editor = page.locator('[role="dialog"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 6000 });

  // Type the slash trigger into the editor. The leading space satisfies the
  // `(?:^|\s)\/` trigger regex the editor listens for.
  await editor.click();
  await page.keyboard.type(' /draft');

  // The slash menu is a fixed-position listbox rendered outside the dialog.
  const draftOption = page.getByRole('option', { name: /Draft body/i });
  await expect(draftOption).toBeVisible({ timeout: 4000 });
  await draftOption.click();

  // THE PROOF: the markdown parsed into real nodes. A literal-text bug would
  // render "# Drafted Heading" inside a paragraph with a literal "#".
  await expect(editor.locator('h1')).toHaveText(/Drafted Heading/, { timeout: 6000 });
  await expect(editor.locator('ul li')).toHaveCount(2);
  // And the raw "# " hash is NOT present as literal text.
  await expect(editor).not.toContainText('# Drafted Heading');
});
