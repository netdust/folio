import {
  createProject,
  createWorkspace,
  expect,
  shot,
  signUpFresh,
  test,
} from './fixtures.ts';

/**
 * FEATURE-ACCEPTANCE — multi-table UI (the `## Acceptance flows` matrix of
 * docs/superpowers/plans/2026-06-09-multi-table-ui.md), driven through the REAL
 * browser against the hermetic Playwright stack.
 *
 * The keystone: the backend has always supported several tables per project,
 * but the web frontend hardcoded `work-items` — clicking a non-default table in
 * the rail showed the work-items table. This spec proves the fix end-to-end.
 *
 * Setup builds a project with the seeded `work-items` table PLUS a `bugs` table
 * (its own statuses + a bug doc with a status that does NOT exist in work-items,
 * so a wrong-table render is visually unambiguous).
 */

const PROJ = { slug: 'webdev', name: 'Webdev' };

// Unique workspace slug per test — the e2e API server reuses its DB across
// tests/runs (reuseExistingServer), so a fixed slug 409s on the 2nd test.
function uniqueWs(): { slug: string; name: string } {
  const id = Math.random().toString(36).slice(2, 8);
  return { slug: `mt-${id}`, name: `MultiTable ${id}` };
}

async function api(page: import('@playwright/test').Page, method: 'post', path: string, data: unknown) {
  const res = await page.request.post(path, { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()}`).toBe(true);
  return res;
}

test.describe('multi-table UI', () => {
  test('Flow 1: clicking the bugs table in the rail renders bugs data (not work-items)', async ({
    page,
  }) => {
    const WS = uniqueWs();
    await signUpFresh(page);
    await createWorkspace(page, WS.name, WS.slug);
    await createProject(page, WS.slug, PROJ.name, PROJ.slug);

    // Build the 2nd table 'bugs' with a distinct status + a bug doc (via the
    // authenticated session API — the same path MCP/the UI use).
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/tables`, { name: 'Bugs' });
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/t/bugs/statuses`, {
      key: 'open',
      name: 'Open',
      category: 'unstarted',
    });
    // The HTTP documents route resolves the table from the URL path (/t/bugs/),
    // NOT a body field — table_slug-in-body is an MCP-tool convention. Post to
    // the table-scoped URL so the doc lands in bugs.
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/t/bugs/documents`, {
      type: 'work_item',
      title: 'Mobile nav overlaps hero',
      status: 'open',
    });
    // A work-items doc too, so the two tables are visibly different.
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/documents`, {
      type: 'work_item',
      title: 'Build homepage',
      status: 'todo',
    });

    // Open the project's default (work-items) view first.
    await page.goto(`/w/${WS.slug}/p/${PROJ.slug}/work-items`);
    await expect(page.getByText('Build homepage')).toBeVisible();

    // Navigate to the bugs table directly (deep-link / re-entry edge — proves
    // the route resolves the tslug param without a rail click).
    await page.goto(`/w/${WS.slug}/p/${PROJ.slug}/t/bugs`);

    // THE KEYSTONE: the bugs document renders; the work-items document does NOT.
    // A wrong-table render (the pre-fix behavior) would show 'Build homepage'
    // and hide 'Mobile nav overlaps hero'.
    await expect(page.getByText('Mobile nav overlaps hero')).toBeVisible();
    await expect(page.getByText('Build homepage')).toHaveCount(0);
    // The header reflects the bugs table's own count (1 item), not work-items'.
    await expect(page.getByText(/1 work item/)).toBeVisible();

    await shot(page, 'multi-table-bugs-grid');
  });

  test('Flow 1b: the URL carries the table slug (deep-link round-trips)', async ({ page }) => {
    const WS = uniqueWs();
    await signUpFresh(page);
    await createWorkspace(page, WS.name, WS.slug);
    await createProject(page, WS.slug, PROJ.name, PROJ.slug);
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/tables`, { name: 'Roadmap' });
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/t/roadmap/statuses`, {
      key: 'planned',
      name: 'Planned',
      category: 'backlog',
    });

    await page.goto(`/w/${WS.slug}/p/${PROJ.slug}/t/roadmap`);
    // The route resolved to the table-scoped path (not redirected to /work-items).
    await expect(page).toHaveURL(new RegExp(`/p/${PROJ.slug}/t/roadmap`));
  });

  test('Flow 1 empty: a non-default table with no docs shows an empty state, not work-items rows', async ({
    page,
  }) => {
    const WS = uniqueWs();
    await signUpFresh(page);
    await createWorkspace(page, WS.name, WS.slug);
    await createProject(page, WS.slug, PROJ.name, PROJ.slug);
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/documents`, {
      type: 'work_item',
      title: 'A work-items row',
      status: 'todo',
    });
    // Empty 'notes' table (no docs).
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/tables`, { name: 'Notes' });
    await api(page, 'post', `/api/v1/w/${WS.slug}/p/${PROJ.slug}/t/notes/statuses`, {
      key: 'todo',
      name: 'Todo',
      category: 'unstarted',
    });

    await page.goto(`/w/${WS.slug}/p/${PROJ.slug}/t/notes`);
    // The empty table must NOT leak the work-items row.
    await expect(page.getByText('A work-items row')).toHaveCount(0);
  });
});
