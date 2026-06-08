import { test, expect, type Page, type Locator } from '@playwright/test';
import { signUpFresh, createWorkspace, createProject } from './fixtures.ts';

/**
 * Feature-acceptance for view DRAG-reorder (plan 2026-06-08-view-drag-reorder).
 * Drives the rail dnd-kit drag through the REAL browser — the menu Move up/down
 * path is covered by view-reorder.spec.ts; this proves the drag interaction.
 *
 * dnd-kit's PointerSensor listens for POINTER events (page.mouse synthesizes MOUSE
 * events the sensor ignores), so we dispatch real PointerEvents: pointerdown on the
 * source row, stepped pointermoves on document (window-level listeners), pointerup.
 * Same technique as hardening-pass.spec.ts's kanban drag.
 *
 * Matrix: D1 drag down, D2 multi-slot drag up, D3 persist across reload.
 */

let seq = 0;
function freshSlugs() {
  seq += 1;
  return { wslug: `vd-ws-${Date.now()}-${seq}`, pslug: `vd-p-${seq}` };
}

async function createListView(page: Page, name: string) {
  await page.getByRole('button', { name: /New view/i }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(/New view/i).first()).toBeVisible();
  await sheet.locator('#view-name').fill(name);
  await sheet.getByRole('button', { name: /^Create/i }).click();
  await expect(sheet).toBeHidden({ timeout: 6000 });
}

/** Persisted view names sorted by order (wire truth). */
async function persistedViewNames(page: Page, wslug: string, pslug: string): Promise<string[]> {
  const res = await page.request.get(`/api/v1/w/${wslug}/p/${pslug}/views`);
  const views = ((await res.json()).data ?? []) as Array<{ name: string; order: number }>;
  return [...views].sort((a, b) => a.order - b.order).map((v) => v.name);
}

/** The rail view row whose label is exactly `label`. */
function viewRow(page: Page, label: string): Locator {
  return page.getByTestId('rail-tree-item').filter({ hasText: new RegExp(`^${label}$`) });
}

/** Drag `src` onto `dst` via real PointerEvents (dnd-kit PointerSensor). Aims at the
 *  dst's vertical center, stepping to clear the 5px activation distance. */
async function dragRowOnto(page: Page, src: Locator, dst: Locator) {
  const s = await src.boundingBox();
  const d = await dst.boundingBox();
  expect(s && d, 'both rows have bounding boxes').toBeTruthy();
  const sx = s!.x + s!.width / 2;
  const sy = s!.y + s!.height / 2;
  const dx = d!.x + d!.width / 2;
  const dy = d!.y + d!.height / 2;

  await src.evaluate(
    (el, { sx, sy }) => {
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          button: 0,
          clientX: sx,
          clientY: sy,
        }),
      );
    },
    { sx, sy },
  );
  const stepN = 12;
  for (let i = 1; i <= stepN; i++) {
    const cx = sx + ((dx - sx) * i) / stepN;
    const cy = sy + ((dy - sy) * i) / stepN;
    await page.evaluate(
      ({ cx, cy }) => {
        document.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: cy }),
        );
      },
      { cx, cy },
    );
    await page.waitForTimeout(20);
  }
  await page.evaluate(
    ({ dx, dy }) => {
      document.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, clientX: dx, clientY: dy }),
      );
    },
    { dx, dy },
  );
  await page.waitForTimeout(250);
}

test('D1+D3: drag a view down past a neighbor persists, and survives reload', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `VD ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);

  await createListView(page, 'Apple');
  await createListView(page, 'Cherry');

  const before = await persistedViewNames(page, wslug, pslug);
  expect(before.indexOf('Apple')).toBeLessThan(before.indexOf('Cherry'));

  // Drag Apple DOWN onto Cherry → Apple lands after Cherry.
  await dragRowOnto(page, viewRow(page, 'Apple'), viewRow(page, 'Cherry'));

  await expect(async () => {
    const after = await persistedViewNames(page, wslug, pslug);
    expect(after.indexOf('Apple')).toBeGreaterThan(after.indexOf('Cherry'));
  }).toPass({ timeout: 6000 });

  // D3: persists across a full reload, reflected in the rail DOM (y-position).
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  await expect(async () => {
    const appleBox = await viewRow(page, 'Apple').boundingBox();
    const cherryBox = await viewRow(page, 'Cherry').boundingBox();
    expect(appleBox && cherryBox).toBeTruthy();
    expect(appleBox!.y).toBeGreaterThan(cherryBox!.y); // Apple now below Cherry
  }).toPass({ timeout: 6000 });
});

test('D2: drag a view up several slots lands it in the dropped position', async ({ page }) => {
  await signUpFresh(page);
  const { wslug, pslug } = freshSlugs();
  await createWorkspace(page, `VD ${seq}`, wslug);
  await createProject(page, wslug, `Proj ${seq}`, pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);

  // Seeded default view + three created → enough span for a multi-slot move.
  await createListView(page, 'One');
  await createListView(page, 'Two');
  await createListView(page, 'Three');

  const before = await persistedViewNames(page, wslug, pslug);
  // 'Three' is last among the created trio; drag it up onto 'One' (multi-slot).
  expect(before.indexOf('Three')).toBeGreaterThan(before.indexOf('One'));

  await dragRowOnto(page, viewRow(page, 'Three'), viewRow(page, 'One'));

  await expect(async () => {
    const after = await persistedViewNames(page, wslug, pslug);
    // Three jumped above One (and thus above Two) — a multi-slot move, not just ±1.
    expect(after.indexOf('Three')).toBeLessThan(after.indexOf('One'));
    expect(after.indexOf('Three')).toBeLessThan(after.indexOf('Two'));
  }).toPass({ timeout: 6000 });
});
