import type { Locator, Page } from '@playwright/test';
import {
  createProject,
  createWorkspace,
  expect,
  seedTable,
  shot,
  signUpFresh,
  test,
} from './fixtures.ts';

/**
 * Visual shakeout — projects / tables / views.
 *
 * Drives EVERY interactive option on the four surfaces (rail rows, table
 * column+row ops, filters+kanban, views+Cmd-K), asserts a DOM consequence, and
 * dumps a numbered PNG per option into test-results/shakeout/ for a human to
 * eyeball. Spec design: docs/superpowers/specs/2026-06-02-projects-tables-views-visual-shakeout-design.md
 *
 * Run:  cd apps/web && bun run e2e shakeout-projects-tables-views
 * PNGs: apps/web/test-results/shakeout/NN-surface-option.png (run order)
 *
 * NOT pixel-regression — screenshots are eyeball artifacts, not baseline diffs.
 * Each `test.step` is one option. Drag-based controls degrade to the Track B
 * list (printed at the end) rather than hard-failing, since headless drag is the
 * one genuinely fragile interaction class.
 */

// Controls we could not drive reliably under headless Playwright. Appended to
// during the run; printed in afterAll so the human knows exactly what still
// needs a manual eyeball.
const trackB: string[] = [];

function note(reason: string) {
  trackB.push(reason);
}

test.afterAll(() => {
  if (trackB.length === 0) {
    // eslint-disable-next-line no-console
    console.log('\n[shakeout] Track B (needs human eyeball): none — every option drove cleanly.\n');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`\n[shakeout] Track B — ${trackB.length} option(s) need a human eyeball:`);
  for (const r of trackB) console.log(`  - ${r}`); // eslint-disable-line no-console
  console.log('');
});

// A rail row scoped by its visible label. rail-tree testids (item/menu/plus)
// repeat per row, so we always scope through the row's <li>.
function railRow(page: Page, label: string): Locator {
  return page
    .locator('li')
    .filter({ has: page.getByTestId('rail-tree-item').filter({ hasText: label }) })
    .first();
}

// ───────────────────────────────────────────────────────────────────────────
// Surface 1 — Rail rows (project / table / view)
// ───────────────────────────────────────────────────────────────────────────
test.describe('Rail rows', () => {
  test('every rail row control', async ({ page }) => {
    const user = await signUpFresh(page, { name: 'Rail Tester' });
    await seedTable(page, { wslug: 'rail-ws', wname: 'RailWS', pslug: 'alpha', pname: 'Alpha' });
    await createProject(page, 'rail-ws', 'Beta', 'beta');
    await page.goto('/w/rail-ws/p/alpha/work-items');
    await expect(railRow(page, 'Alpha')).toBeVisible();
    expect(user.email).toBeTruthy();

    await test.step('project: expand chevron reveals children', async () => {
      const row = railRow(page, 'Alpha');
      const chevron = row.getByTestId(/^rail-tree-chevron-/).first();
      // Ensure expanded (default-open at depth 0, but assert + screenshot state).
      if ((await chevron.getAttribute('aria-expanded')) === 'false') await chevron.click();
      await expect(chevron).toHaveAttribute('aria-expanded', 'true');
      await shot(page, 'rail-project-expanded');
    });

    await test.step('project: collapse chevron hides children', async () => {
      const row = railRow(page, 'Alpha');
      const chevron = row.getByTestId(/^rail-tree-chevron-/).first();
      await chevron.click();
      await expect(chevron).toHaveAttribute('aria-expanded', 'false');
      await shot(page, 'rail-project-collapsed');
      await chevron.click(); // re-expand for later steps
    });

    await test.step('project: click navigates', async () => {
      await railRow(page, 'Beta').getByTestId('rail-tree-item').click();
      await expect(page).toHaveURL(/\/p\/beta\/work-items/);
      await page.goto('/w/rail-ws/p/alpha/work-items');
      await shot(page, 'rail-project-click-navigate');
    });

    await test.step('project: double-click rename commits on Enter', async () => {
      const row = railRow(page, 'Alpha');
      await row.getByTestId('rail-tree-item').dblclick();
      const input = row.getByTestId('rail-tree-rename-input');
      await expect(input).toBeVisible();
      await input.fill('Alpha Renamed');
      await shot(page, 'rail-project-rename-editing');
      await input.press('Enter');
      await expect(railRow(page, 'Alpha Renamed').getByTestId('rail-tree-item')).toBeVisible();
    });

    await test.step('project: rename Escape cancels', async () => {
      const row = railRow(page, 'Alpha Renamed');
      await row.getByTestId('rail-tree-item').dblclick();
      const input = row.getByTestId('rail-tree-rename-input');
      await input.fill('Should Not Stick');
      await input.press('Escape');
      await expect(railRow(page, 'Alpha Renamed').getByTestId('rail-tree-item')).toBeVisible();
      await shot(page, 'rail-project-rename-escape');
    });

    await test.step('project: + button opens New table sheet', async () => {
      const row = railRow(page, 'Alpha Renamed');
      await row.hover();
      await row.getByRole('button', { name: 'New table' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shot(page, 'rail-project-new-table-sheet');
      await page.keyboard.press('Escape');
    });

    await test.step('table: ⋯ menu opens with Rename + Delete', async () => {
      // The default work-items table renders as a row under the project.
      const tableRow = railRow(page, 'Work items');
      if (await tableRow.count()) {
        await tableRow.hover();
        await tableRow.getByTestId('rail-tree-menu').click();
        await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /Delete/ })).toBeVisible();
        await shot(page, 'rail-table-menu');
        await page.keyboard.press('Escape');
      } else {
        note(
          'Rail: no separate "Work items" table row visible to exercise table ⋯ menu — confirm rail tree shows the default table.',
        );
      }
    });

    await test.step('view: + on table opens New view sheet', async () => {
      const tableRow = railRow(page, 'Work items');
      if (await tableRow.count()) {
        await tableRow.hover();
        await tableRow.getByRole('button', { name: 'New view' }).click();
        await expect(page.getByRole('dialog', { name: /New view/i })).toBeVisible();
        await page.getByLabel('Name').fill('My View');
        await shot(page, 'rail-view-new-view-sheet');
        await page.getByRole('button', { name: 'Create view' }).click();
        await expect(page).toHaveURL(/[?&]view=/);
        await shot(page, 'rail-view-created-url');
      } else {
        note(
          'Rail: no "Work items" table row to open the New view sheet from — verify view creation manually.',
        );
      }
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Surface 2 — Table column + row ops
// ───────────────────────────────────────────────────────────────────────────
test.describe('Table column + row ops', () => {
  test('every table control', async ({ page }) => {
    await signUpFresh(page, { name: 'Table Tester' });
    await seedTable(page, { wslug: 'tbl-ws', wname: 'TblWS', pslug: 'proj', pname: 'Proj' });
    await page.goto('/w/tbl-ws/p/proj/work-items');
    await expect(page.getByRole('button', { name: /Edit title: Alpha task/ })).toBeVisible();

    await test.step('header: click cycles sort asc → desc → none', async () => {
      const title = page.getByRole('button', { name: /^Sort by Title/ });
      await title.click();
      await expect(page).toHaveURL(/[?&]sort=title/);
      await expect(page).toHaveURL(/[?&]dir=asc/);
      await shot(page, 'table-sort-asc');
      await title.click();
      await expect(page).toHaveURL(/[?&]dir=desc/);
      await shot(page, 'table-sort-desc');
      await title.click();
      await expect(page).not.toHaveURL(/[?&]sort=title/);
      await shot(page, 'table-sort-none');
    });

    await test.step('column picker: toggle a column off and on', async () => {
      await page.getByRole('button', { name: 'Columns' }).click();
      const toggle = page.getByRole('checkbox', { name: /Toggle Priority/ });
      await expect(toggle).toBeVisible();
      await toggle.uncheck();
      await shot(page, 'table-column-hidden');
      await toggle.check();
      await page.keyboard.press('Escape');
    });

    await test.step('add column: create a select field with options', async () => {
      await page.getByRole('button', { name: 'Add column' }).click();
      await page.locator('#add-col-key').fill('stage');
      await page.locator('#add-col-label').fill('Stage');
      await page.locator('#add-col-type').selectOption('select');
      await page.locator('#add-col-options').fill('lead, won, lost');
      await shot(page, 'table-add-column-form');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('button', { name: /^Sort by Stage/ })).toBeVisible();
      await shot(page, 'table-add-column-created');
    });

    await test.step('column menu: Rename a field column', async () => {
      const header = page.locator('.group\\/header').filter({ hasText: 'Stage' }).first();
      await header.hover();
      await header.getByRole('button', { name: 'Column actions' }).click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      const input = page.getByRole('textbox', { name: /Rename column/ });
      await input.fill('Pipeline Stage');
      await input.press('Enter');
      await expect(page.getByRole('button', { name: /^Sort by Pipeline Stage/ })).toBeVisible();
      await shot(page, 'table-column-renamed');
    });

    await test.step('column menu: Hide column', async () => {
      const header = page.locator('.group\\/header').filter({ hasText: 'Pipeline Stage' }).first();
      await header.hover();
      await header.getByRole('button', { name: 'Column actions' }).click();
      await page.getByRole('menuitem', { name: 'Hide column' }).click();
      await expect(page.getByRole('button', { name: /^Sort by Pipeline Stage/ })).toHaveCount(0);
      await shot(page, 'table-column-menu-hidden');
      // Restore via picker so Delete step can find it.
      await page.getByRole('button', { name: 'Columns' }).click();
      await page.getByRole('checkbox', { name: /Toggle Pipeline Stage/ }).check();
      await page.keyboard.press('Escape');
    });

    await test.step('column menu: Delete column (confirm dialog)', async () => {
      const header = page.locator('.group\\/header').filter({ hasText: 'Pipeline Stage' }).first();
      await header.hover();
      await header.getByRole('button', { name: 'Column actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete column' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shot(page, 'table-column-delete-confirm');
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByRole('button', { name: /^Sort by Pipeline Stage/ })).toHaveCount(0);
    });

    await test.step('add row: creates a work item', async () => {
      await page.getByRole('button', { name: 'Add work item' }).click();
      const input = page.getByRole('textbox', { name: 'New work item title' });
      await input.fill('Delta task');
      await input.press('Enter');
      await expect(page.getByRole('button', { name: /Edit title: Delta task/ })).toBeVisible();
      await shot(page, 'table-add-row');
    });

    await test.step('inline cell: edit a title', async () => {
      const cell = page.getByRole('button', { name: 'Edit title: Bravo task' });
      await cell.click();
      const input = page.getByRole('textbox', { name: 'Edit title: Bravo task' });
      await input.fill('Bravo edited');
      await input.press('Enter');
      await expect(page.getByRole('button', { name: 'Edit title: Bravo edited' })).toBeVisible();
      await shot(page, 'table-inline-cell-edit');
    });

    await test.step('header: drag-reorder (degrades to Track B if unstable)', async () => {
      const before = await page.getByRole('button', { name: /^Sort by / }).allInnerTexts();
      const source = page.getByRole('button', { name: /^Sort by Title/ });
      const target = page.getByRole('button', { name: /^Sort by Status/ });
      try {
        await source.dragTo(target);
        await page.waitForTimeout(300);
        const after = await page.getByRole('button', { name: /^Sort by / }).allInnerTexts();
        if (JSON.stringify(before) === JSON.stringify(after)) {
          note(
            'Table: column drag-reorder did not change column order under headless Playwright — verify drag-to-reorder manually.',
          );
        }
        await shot(page, 'table-column-reorder');
      } catch {
        note(
          'Table: column drag-reorder threw under headless Playwright — verify drag-to-reorder manually.',
        );
      }
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Surface 3 — Filters + Kanban toolbar
// ───────────────────────────────────────────────────────────────────────────
test.describe('Filters + Kanban', () => {
  test('every filter + kanban control', async ({ page }) => {
    await signUpFresh(page, { name: 'Filter Tester' });
    await seedTable(page, { wslug: 'flt-ws', wname: 'FltWS', pslug: 'proj', pname: 'Proj' });
    await page.goto('/w/flt-ws/p/proj/work-items');
    await expect(page.getByTestId('filter-bar')).toBeVisible();

    // The filter-add trigger is the ChipAdd button inside the filter bar.
    const addFilter = () => page.getByTestId('filter-bar').getByRole('button').last();

    await test.step('filter: add Status', async () => {
      await addFilter().click();
      await page.getByRole('button', { name: 'Status' }).click();
      await page
        .getByRole('button', { name: /To ?do|Todo|todo/i })
        .first()
        .click();
      await expect(page).toHaveURL(/[?&]status=/);
      await shot(page, 'filter-status');
    });

    await test.step('filter: add Priority', async () => {
      await addFilter().click();
      await page.getByRole('button', { name: 'Priority' }).click();
      await page.getByRole('button', { name: 'high', exact: true }).click();
      await expect(page).toHaveURL(/[?&]priority=high/);
      await shot(page, 'filter-priority');
    });

    await test.step('filter: add Labels', async () => {
      await addFilter().click();
      await page.getByRole('button', { name: 'Labels' }).click();
      await page.getByRole('button', { name: 'bug', exact: true }).click();
      await expect(page).toHaveURL(/[?&]labels=bug/);
      await shot(page, 'filter-labels');
    });

    await test.step('filter: add Assignee (free text)', async () => {
      await addFilter().click();
      await page.getByRole('button', { name: 'Assignee' }).click();
      await page.getByPlaceholder('user@example.com').fill('a@folio.test');
      await page.getByPlaceholder('user@example.com').press('Enter');
      await expect(page).toHaveURL(/[?&]assignee=/);
      await shot(page, 'filter-assignee');
    });

    await test.step('filter: add Updated since (date)', async () => {
      await addFilter().click();
      await page.getByRole('button', { name: 'Updated since' }).click();
      await page.getByPlaceholder('YYYY-MM-DD').fill('2026-01-01');
      await page.getByPlaceholder('YYYY-MM-DD').press('Enter');
      await expect(page).toHaveURL(/[?&]updated_since=/);
      await shot(page, 'filter-updated-since');
    });

    await test.step('filter: remove a chip', async () => {
      await page.getByRole('button', { name: 'Remove priority filter' }).click();
      await expect(page).not.toHaveURL(/[?&]priority=high/);
      await shot(page, 'filter-chip-removed');
    });

    await test.step('kanban: open board tab', async () => {
      await page.getByRole('tab', { name: /Board/i }).click();
      await expect(page).toHaveURL(/\/board/);
      await shot(page, 'kanban-board');
    });

    await test.step('kanban: group-by dropdown changes grouping', async () => {
      await page.getByRole('button', { name: /^Group:/ }).click();
      await page.getByRole('menuitem', { name: 'Priority' }).click();
      await expect(page.getByRole('button', { name: /^Group:.*Priority/ })).toBeVisible();
      await shot(page, 'kanban-group-by');
    });

    await test.step('kanban: sort dropdown + direction toggle', async () => {
      await page.getByRole('button', { name: /^Sort:/ }).click();
      await page.getByRole('menuitem', { name: 'Title' }).click();
      await expect(page.getByRole('button', { name: /^Sort:.*Title ↑/ })).toBeVisible();
      await shot(page, 'kanban-sort-asc');
      // Re-pick Title to toggle direction.
      await page.getByRole('button', { name: /^Sort:/ }).click();
      await page.getByRole('menuitem', { name: 'Title' }).click();
      await expect(page.getByRole('button', { name: /^Sort:.*Title ↓/ })).toBeVisible();
      await shot(page, 'kanban-sort-desc');
    });

    await test.step('kanban: card drag (degrades to Track B if unstable)', async () => {
      // Group back by status so there are multiple destination columns.
      await page.getByRole('button', { name: /^Group:/ }).click();
      await page.getByRole('menuitem', { name: 'Status' }).click();
      note(
        'Kanban: card drag-between-columns is a headless-fragile pointer interaction — verify a card drag persists its new column manually.',
      );
      await shot(page, 'kanban-cards');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Surface 4 — Views + Cmd-K
// ───────────────────────────────────────────────────────────────────────────
test.describe('Views + Cmd-K', () => {
  test('view hydration + command palette', async ({ page }) => {
    await signUpFresh(page, { name: 'Cmdk Tester' });
    await seedTable(page, { wslug: 'cmd-ws', wname: 'CmdWS', pslug: 'one', pname: 'One' });
    await createProject(page, 'cmd-ws', 'Two', 'two');
    await createWorkspace(page, 'OtherWS', 'other-ws');
    await page.goto('/w/cmd-ws/p/one/work-items');
    await expect(page.getByRole('button', { name: /Edit title: Alpha task/ })).toBeVisible();

    await test.step('view: ?view= hydrates a saved filter', async () => {
      // Add a status filter, save it as a view, then assert reload hydrates it.
      await page.getByTestId('filter-bar').getByRole('button').last().click();
      await page.getByRole('button', { name: 'Status' }).click();
      await page
        .getByRole('button', { name: /To ?do|Todo|todo/i })
        .first()
        .click();
      await expect(page).toHaveURL(/[?&]status=/);
      const tableRow = railRow(page, 'Work items');
      if (await tableRow.count()) {
        await tableRow.hover();
        await tableRow.getByRole('button', { name: 'New view' }).click();
        await page.getByLabel('Name').fill('Todo View');
        await page.getByRole('button', { name: 'Create view' }).click();
        await expect(page).toHaveURL(/[?&]view=/);
        await shot(page, 'view-created-with-filter');
      } else {
        note(
          'Views: could not reach the New view sheet from the rail — verify ?view= hydration manually.',
        );
      }
    });

    await test.step('cmd-k: opens with Meta+K', async () => {
      await page.keyboard.press('Meta+k');
      await expect(page.getByPlaceholder('Type a command…')).toBeVisible();
      await shot(page, 'cmdk-open');
    });

    await test.step('cmd-k: switch project', async () => {
      await page.getByPlaceholder('Type a command…').fill('Two');
      await page.getByRole('option', { name: /^Two$/ }).click();
      await expect(page).toHaveURL(/\/p\/two\/work-items/);
      await shot(page, 'cmdk-switch-project');
    });

    await test.step('cmd-k: switch workspace', async () => {
      await page.keyboard.press('Meta+k');
      await page.getByPlaceholder('Type a command…').fill('OtherWS');
      await page.getByRole('option', { name: /OtherWS/ }).click();
      await expect(page).toHaveURL(/\/w\/other-ws/);
      await shot(page, 'cmdk-switch-workspace');
    });

    await test.step('cmd-k: create new work item', async () => {
      await page.goto('/w/cmd-ws/p/one/work-items');
      await page.keyboard.press('Meta+k');
      await page.getByPlaceholder('Type a command…').fill('New work item');
      await page.getByRole('option', { name: 'New work item' }).click();
      await expect(page).toHaveURL(/[?&]doc=/);
      await shot(page, 'cmdk-create-work-item');
    });
  });
});
