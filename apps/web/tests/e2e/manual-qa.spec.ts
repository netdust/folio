/**
 * E2E coverage for the 15-scenario manual QA list in
 * `apps/web/tests/manual-qa-phase-1.md`.
 *
 * Each `test('scenario N — ...')` block maps to the same-numbered scenario.
 *
 * Scenarios deliberately covered by Vitest unit tests, not Playwright:
 *   - 7  (mode toggle internals): `src/components/slideover/__roundtrip__/round-trip.test.tsx`.
 *   - 14 (offline rollback): the optimistic mutation helper is unit tested;
 *     forcing a network failure in Playwright is flaky.
 */

import { test, expect, signUpFresh, createWorkspace, createProject } from './fixtures.ts';
import type { Page } from '@playwright/test';

// Use a per-test counter to avoid slug collisions in the shared e2e DB.
let testSeq = 0;
function freshSlugs() {
  testSeq += 1;
  return {
    wslug: `ws-${testSeq}-${Date.now().toString(36)}`,
    pslug: `proj-${testSeq}-${Date.now().toString(36)}`,
  };
}

async function bootstrapProject(page: Page) {
  const user = await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `WS ${testSeq}`, wslug);
  await createProject(page, wslug, `Proj ${testSeq}`, pslug);
  return { user, wslug, pslug };
}

async function seedWorkItem(
  page: Page,
  wslug: string,
  pslug: string,
  data: { title: string; body?: string; status?: string; frontmatter?: Record<string, unknown> },
): Promise<string> {
  const fm = data.status
    ? { ...(data.frontmatter ?? {}), status: data.status }
    : data.frontmatter;
  const res = await page.request.post(`/api/v1/w/${wslug}/p/${pslug}/documents`, {
    data: {
      type: 'work_item',
      title: data.title,
      ...(data.body !== undefined ? { body: data.body } : {}),
      ...(fm ? { frontmatter: fm } : {}),
    },
  });
  expect(res.ok(), `seed ${data.title} → ${res.status()}`).toBe(true);
  return (await res.json()).data.slug;
}

test('scenario 1 — onboarding: workspace create lands you in the workspace', async ({ page }) => {
  await signUpFresh(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome to Folio/i })).toBeVisible();
  await page.getByRole('button', { name: /Create workspace/i }).click();
  const wsName = `Spring ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(wsName);
  // Submit button inside the sheet is now just "Create" (was "Create workspace"
  // before — collided with the empty-state CTA's name).
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/w\/spring-/);
});

test('scenario 2 — onboarding: project create lands on work-items list', async ({ page }) => {
  await signUpFresh(page);
  const { wslug } = freshSlugs();
  await createWorkspace(page, `WS ${testSeq}`, wslug);
  await page.goto(`/w/${wslug}`);
  await page.getByRole('button', { name: /Create project/i }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Gallery Ops');
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${wslug}/p/gallery-ops/work-items`));
});

test('scenario 3 — list view: inline title edit persists', async ({ page }) => {
  const { wslug, pslug } = await bootstrapProject(page);
  await seedWorkItem(page, wslug, pslug, { title: 'Original title' });

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  // InlineEdit (closed) renders as role=button with aria-label `Edit title: <title>`.
  const titleCell = page.getByRole('button', { name: 'Edit title: Original title' });
  await expect(titleCell).toBeVisible();
  await titleCell.click();

  // Now it's an input with the same aria-label.
  const input = page.getByRole('textbox', { name: 'Edit title: Original title' });
  await input.fill('Edited title');
  await input.press('Enter');

  // Reload to prove the edit persisted to the server.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit title: Edited title' })).toBeVisible();
});

test('scenario 4 — list view: inline status edit persists', async ({ page }) => {
  const { wslug, pslug } = await bootstrapProject(page);
  const slug = await seedWorkItem(page, wslug, pslug, {
    title: 'Status doc',
    status: 'backlog',
  });

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  // Each list row is grid-laid out: title cell, status (InlineSelect), updated.
  // The InlineSelect trigger is the only button whose accessible name is the
  // current status label ("Backlog") on that row.
  const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit title: Status doc' }) });
  await row.getByRole('button', { name: 'Backlog' }).click();

  // Popover opens with options as role=option.
  await page.getByRole('option', { name: 'Todo' }).click();

  // Optimistic: the row's status pill now reads "Todo".
  await expect(row.getByRole('button', { name: 'Todo' })).toBeVisible();

  // Confirm via API that it was actually persisted.
  const res = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}`);
  expect(res.ok()).toBe(true);
  expect((await res.json()).data.status).toBe('todo');
});

test('scenario 5 — slideover opens via row icon and closes on Escape', async ({ page }) => {
  const { wslug, pslug } = await bootstrapProject(page);
  await seedWorkItem(page, wslug, pslug, { title: 'Open me' });

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  // Row "Open <title>" button — already covered by the a11y regression test,
  // exists on every row with a stable aria-label.
  await page.getByRole('button', { name: 'Open Open me' }).click();

  // Slideover (Sheet) is role=dialog. Doc opens via ?doc= query string.
  const sheet = page.locator('[role="dialog"]').filter({ has: page.getByRole('button', { name: 'Close document' }) });
  await expect(sheet).toBeVisible();
  // Match `doc=open-me` anywhere in the query string — the URL may carry
  // additional params (sort, dir, view) preserved by hydration.
  await expect(page).toHaveURL(/[?&]doc=open-me/);

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]doc=/);
});

test('scenario 6 — slideover renders frontmatter form and body editor', async ({ page }) => {
  const { wslug, pslug } = await bootstrapProject(page);
  const slug = await seedWorkItem(page, wslug, pslug, {
    title: 'FM doc',
    body: '# Hello body',
    status: 'todo',
    frontmatter: { priority: 'high' },
  });

  await page.goto(`/w/${wslug}/p/${pslug}/work-items?doc=${slug}`);

  const sheet = page.locator('[role="dialog"]').filter({ has: page.getByRole('button', { name: 'Close document' }) });
  await expect(sheet).toBeVisible();

  // Slug breadcrumb proves the body header rendered.
  await expect(sheet.getByText(`/${slug}`)).toBeVisible();

  // Frontmatter keys render in a <dl> with <dt> labels.
  await expect(sheet.locator('dt').filter({ hasText: /^status$/ })).toBeVisible();
  await expect(sheet.locator('dt').filter({ hasText: /^priority$/ })).toBeVisible();

  // Status InlineSelect shows the current status label.
  await expect(sheet.getByRole('button', { name: 'Todo' })).toBeVisible();

  // Body editor (ProseMirror) mounts with rich-mode default.
  await expect(sheet.locator('.ProseMirror')).toBeVisible();
});

test('scenario 8 — markdown round-trip preserves frontmatter + body', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `WS ${testSeq}`, wslug);
  await createProject(page, wslug, `Proj ${testSeq}`, pslug);

  // Server resolves title from the first `# heading` (see
  // parseMarkdownInput in routes/documents.ts) — so omit the heading and let
  // the YAML title win, exercising the frontmatter→title path explicitly.
  const sourceMd = [
    '---',
    'title: Round-Trip Doc',
    'type: work_item',
    'status: todo',
    'priority: high',
    'labels:',
    '  - alpha',
    '  - beta',
    '---',
    '',
    'A body paragraph with **bold** text.',
    '',
    '- list item 1',
    '- list item 2',
    '',
  ].join('\n');

  // Need a status registered before POST will accept frontmatter.status='todo'.
  await page.request.post(`/api/v1/w/${wslug}/p/${pslug}/statuses`, {
    data: { key: 'todo', name: 'Todo' },
  });

  // POST as text/markdown.
  const created = await page.request.post(`/api/v1/w/${wslug}/p/${pslug}/documents`, {
    headers: { 'Content-Type': 'text/markdown' },
    data: sourceMd,
  });
  expect(created.ok(), `POST md → ${created.status()}: ${await created.text()}`).toBe(true);
  const slug = (await created.json()).data.slug;

  // GET back as markdown via the .md route.
  const got = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}.md`);
  expect(got.ok()).toBe(true);
  const roundTripped = await got.text();

  // Frontmatter keys survived.
  expect(roundTripped).toContain('title: Round-Trip Doc');
  expect(roundTripped).toContain('status: todo');
  expect(roundTripped).toContain('priority: high');
  expect(roundTripped).toMatch(/labels:\s*\n\s*-\s*alpha\s*\n\s*-\s*beta/);

  // Body content survived.
  expect(roundTripped).toContain('A body paragraph with **bold** text.');
  expect(roundTripped).toContain('- list item 1');
  expect(roundTripped).toContain('- list item 2');
});

test('scenario 9 — kanban: per-column + creates a doc with that status', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `WS ${testSeq}`, wslug);
  await createProject(page, wslug, `Proj ${testSeq}`, pslug);

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  await page.getByRole('tab', { name: 'Board', exact: true }).click();

  // Per-column "+" button has aria-label "New work item in <Status name>".
  await page.getByRole('button', { name: 'New work item in Todo' }).click();

  // Slideover opens. Type a title and commit.
  const titleInput = page.locator('[role="dialog"] input[type="text"]').first();
  await expect(titleInput).toHaveValue('');
  await titleInput.fill('Card in Todo');
  await titleInput.press('Enter');
  await page.keyboard.press('Escape');

  // Card shows up under Todo with the right title. (The card button isn't
  // marked draggable until @dnd-kit attaches — match by accessible name.)
  await expect(page.getByRole('button', { name: 'Card in Todo' })).toBeVisible();

  // Confirm via API that it persisted with status=todo. The title commits
  // asynchronously via InlineEdit's onCommit → useUpdateDocument; poll until
  // the doc shows up with both the right title and status.
  await expect(async () => {
    const list = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/documents?type=work_item`);
    expect(list.ok()).toBe(true);
    const data = (await list.json()).data as Array<{ title: string; status: string | null }>;
    const card = data.find((d) => d.title === 'Card in Todo');
    expect(card, 'doc with title "Card in Todo" should exist').toBeDefined();
    expect(card?.status).toBe('todo');
  }).toPass({ timeout: 5000 });
});

test('scenario 10 — wiki: create a page from empty state', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `WS ${testSeq}`, wslug);
  await createProject(page, wslug, `Proj ${testSeq}`, pslug);

  await page.goto(`/w/${wslug}/p/${pslug}/wiki`);
  await page.getByRole('button', { name: /Create your first page/ }).click();

  // Slideover opens with title pre-populated as "Untitled" and the editor open.
  const titleInput = page.locator('[role="dialog"] input[type="text"]').first();
  await expect(titleInput).toBeVisible();
  await titleInput.fill('My first wiki page');
  await titleInput.press('Enter');

  // Wiki tree refreshes inline and shows the new page.
  // Close the slideover via its dedicated Close button — pressing Escape
  // alone is fragile because focus may have left the dialog after the
  // inline-edit's Enter commit moved focus to document.body.
  await page.getByRole('button', { name: 'Close document' }).click();
  // The wiki tree row's outer <li> picks up role="button" via dnd-kit's
  // draggable attributes, so it collides with the inner label button on
  // strict-mode lookups. Match by tagName + .first() instead.
  await expect(
    page.locator('button', { hasText: 'My first wiki page' }).first(),
  ).toBeVisible();

  // Confirm persisted via API.
  const list = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/documents?type=page`);
  expect(list.ok()).toBe(true);
  const data = (await list.json()).data;
  expect(data.some((d: { title: string }) => d.title === 'My first wiki page')).toBe(true);
});

test('scenario 11 — copy-as-MD via right-click', async ({ page, context }) => {
  // Grant clipboard permissions so navigator.clipboard.writeText works headless.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const { wslug, pslug } = await bootstrapProject(page);
  await seedWorkItem(page, wslug, pslug, {
    title: 'Copy me',
    body: 'body content here',
  });

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  // Right-click the row. RowContextMenu wraps each row's content.
  const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit title: Copy me' }) });
  await row.click({ button: 'right' });

  // Menu opens as role=menu with role=menuitem children.
  await page.getByRole('menuitem', { name: /Copy as Markdown/ }).click();

  // Read clipboard and assert the MD content.
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('title: Copy me');
  expect(clip).toContain('body content here');
});

test('scenario 12 — filter chip: status=todo filters list', async ({ page }) => {
  const { wslug, pslug } = await bootstrapProject(page);
  await seedWorkItem(page, wslug, pslug, { title: 'Todo task', status: 'todo' });
  await seedWorkItem(page, wslug, pslug, { title: 'Backlog task', status: 'backlog' });

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  await expect(page.getByText('Todo task')).toBeVisible();
  await expect(page.getByText('Backlog task')).toBeVisible();

  // Open the + Filter popover via the FilterAdd ChipAdd trigger.
  await page.getByRole('button', { name: '+ Filter', exact: true }).click();

  // Step 1: pick "Status".
  const popover = page.locator('[data-radix-popper-content-wrapper]');
  await popover.getByRole('button', { name: /^Status\b/ }).click();

  // Step 2: pick "Todo" from the status list. After picking, popover closes
  // and the URL updates with ?status=[...]. Wait for the list to narrow.
  await popover.getByRole('button', { name: /^Todo$/ }).click();

  await expect(page.getByText('Todo task')).toBeVisible();
  await expect(page.getByText('Backlog task')).toHaveCount(0);

  // URL also reflects the filter so reload preserves it.
  await expect(page).toHaveURL(/[?&]status=/);
});

test('scenario 13 — Cmd-K palette opens and "New work item" creates a doc', async ({ page }) => {
  const { wslug, pslug } = await bootstrapProject(page);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);

  // Open via the rail's Search button — same code path as Cmd+K (both call
  // openCommandPalette() from the bus). Avoids keyboard-listener race with
  // hydration in headless mode.
  await page.getByRole('button', { name: /Search/ }).click();

  const palette = page.getByPlaceholder('Type a command…');
  await expect(palette).toBeVisible();

  // Click the "New work item" option (cmdk renders items inside a [cmdk-list]).
  await page.getByRole('option', { name: 'New work item', exact: true }).click();

  // Palette closes, slideover opens for the new doc, ?doc= in URL.
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\?doc=/);

  // Confirm persisted via API.
  const list = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/documents?type=work_item`);
  expect(list.ok()).toBe(true);
  const data = (await list.json()).data;
  expect(data.some((d: { title: string }) => d.title === 'New work item')).toBe(true);
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
