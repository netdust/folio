import { test as base, expect, type Page } from '@playwright/test';

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
export async function createProject(page: Page, wslug: string, name: string, pslug: string): Promise<void> {
  const res = await page.request.post(`/api/v1/w/${wslug}/projects`, {
    data: { name, slug: pslug },
  });
  expect(res.ok(), `create project ${pslug} → ${res.status()}`).toBe(true);
}

export const test = base;
export { expect };
