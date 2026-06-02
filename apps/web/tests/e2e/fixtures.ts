import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, test as base, expect } from '@playwright/test';

/**
 * E2E helpers — sign up a fresh user, then drive the UI as that user.
 *
 * All requests use unique emails so tests don't collide (the e2e DB is shared
 * across one Playwright run; global-setup wipes it before each run).
 */

const E2E_PASSWORD = 'test-password-123';

let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `e2e-${Date.now()}-${seq}@folio.test`;
}

export interface SignedInUser {
  email: string;
  name: string;
  password: string;
}

/**
 * Sign up a fresh user via the API and authenticate the page's cookie jar.
 *
 * Returns the user's credentials so the test can sign in elsewhere if needed.
 */
export async function signUpFresh(page: Page, opts: { name?: string } = {}): Promise<SignedInUser> {
  const email = freshEmail();
  const name = opts.name ?? `User ${seq}`;
  const res = await page.request.post('/api/v1/auth/register', {
    data: { email, password: E2E_PASSWORD, name },
  });
  expect(res.ok(), `register ${email} → ${res.status()}`).toBe(true);
  return { email, name, password: E2E_PASSWORD };
}

/**
 * Create a workspace via the API for a session that's already authenticated
 * via signUpFresh().
 */
export async function createWorkspace(page: Page, name: string, slug: string): Promise<void> {
  const res = await page.request.post('/api/v1/workspaces', {
    data: { name, slug },
  });
  expect(res.ok(), `create workspace ${slug} → ${res.status()}`).toBe(true);
}

/**
 * Create a project under an existing workspace.
 */
export async function createProject(
  page: Page,
  wslug: string,
  name: string,
  pslug: string,
): Promise<void> {
  const res = await page.request.post(`/api/v1/w/${wslug}/projects`, {
    data: { name, slug: pslug },
  });
  expect(res.ok(), `create project ${pslug} → ${res.status()}`).toBe(true);
}

/**
 * Pin a custom field on a project's default (work-items) table so the table
 * shows a column + the filter picker offers it. `priority` (select) and
 * `labels` (multi_select) are what the filter-add popover keys off.
 */
export async function pinField(
  page: Page,
  wslug: string,
  pslug: string,
  field: { key: string; type: string; label?: string; options?: string[] },
): Promise<void> {
  const res = await page.request.post(`/api/v1/w/${wslug}/p/${pslug}/fields`, {
    data: field,
  });
  expect(res.ok(), `pin field ${field.key} → ${res.status()}`).toBe(true);
}

/**
 * Create a work_item via the API. Status + priority + labels live in
 * frontmatter (frontmatter-is-the-schema). Used to give the table/kanban/filter
 * surfaces real rows to act on.
 */
export async function createWorkItem(
  page: Page,
  wslug: string,
  pslug: string,
  title: string,
  frontmatter: Record<string, unknown> = {},
): Promise<void> {
  const res = await page.request.post(`/api/v1/w/${wslug}/p/${pslug}/documents`, {
    data: { type: 'work_item', title, frontmatter },
  });
  expect(res.ok(), `create work item "${title}" → ${res.status()}`).toBe(true);
}

/**
 * Seed a workspace + project with pinned `priority`/`labels` fields and a
 * handful of work items spread across statuses + frontmatter variety, so every
 * table / kanban / filter control has data to act on. Returns nothing — the
 * caller navigates to `/w/${wslug}/p/${pslug}/work-items`.
 */
export async function seedTable(
  page: Page,
  opts: { wslug: string; wname: string; pslug: string; pname: string },
): Promise<void> {
  await createWorkspace(page, opts.wname, opts.wslug);
  await createProject(page, opts.wslug, opts.pname, opts.pslug);
  // priority/labels are the fields the filter-add popover offers as Priority /
  // Labels picks — pin them so those filter kinds appear.
  await pinField(page, opts.wslug, opts.pslug, {
    key: 'priority',
    type: 'select',
    label: 'Priority',
    options: ['low', 'medium', 'high'],
  });
  await pinField(page, opts.wslug, opts.pslug, {
    key: 'labels',
    type: 'multi_select',
    label: 'Labels',
    options: ['bug', 'feature', 'chore'],
  });
  // Default project statuses are seeded by the server (todo / in_progress /
  // done). Spread items across them so sort + kanban grouping have variety.
  await createWorkItem(page, opts.wslug, opts.pslug, 'Alpha task', {
    status: 'todo',
    priority: 'high',
    labels: ['bug'],
    assignee: 'a@folio.test',
  });
  await createWorkItem(page, opts.wslug, opts.pslug, 'Bravo task', {
    status: 'in_progress',
    priority: 'medium',
    labels: ['feature'],
  });
  await createWorkItem(page, opts.wslug, opts.pslug, 'Charlie task', {
    status: 'done',
    priority: 'low',
  });
}

// Screenshot artifacts land here; a human scrolls the folder in run order.
const SHOT_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../test-results/shakeout',
);
let shotSeq = 0;
let shotDirReady = false;

/**
 * Capture a full-page screenshot into test-results/shakeout/NN-name.png with an
 * auto-incrementing zero-padded counter so PNGs sort in run order. This is the
 * human-eyeball artifact — the surrounding test asserts the behaviour; the PNG
 * proves the control rendered right.
 */
export async function shot(page: Page, name: string): Promise<void> {
  if (!shotDirReady) {
    mkdirSync(SHOT_DIR, { recursive: true });
    shotDirReady = true;
  }
  shotSeq += 1;
  const num = String(shotSeq).padStart(2, '0');
  const safe = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await page.screenshot({ path: resolve(SHOT_DIR, `${num}-${safe}.png`), fullPage: true });
}

export const test = base;
export { expect };
