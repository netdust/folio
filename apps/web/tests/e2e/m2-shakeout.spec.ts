/**
 * M2 shake-out — drives the M2 acceptance flows through the real browser.
 *
 * Flow 1: SSE connection count (H8 mux) — ONE EventSource to /events with a
 *         slideover open (the headline win; was 5-7).
 * Flow 2: live update through the mux — list live-updates from a wire write.
 * Flow 3: wiki excerpts (CR-A) — page cards show a body excerpt; empty body = none.
 *
 * Flows 4/5 are driven outside Playwright (curl on the e2e API, code inspection).
 */
import { type Page, expect, test } from '@playwright/test';
import { createProject, createWorkItem, createWorkspace, signUpFresh } from './fixtures.ts';

let seq = 0;
function uniq(p: string) {
  seq += 1;
  return `${p}-${Date.now()}-${seq}`;
}

/**
 * Instrument window.EventSource BEFORE any app code runs so we can count live
 * connections by URL. Returns nothing; read window.__es later.
 */
async function instrumentEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // @ts-expect-error test instrumentation on window
    window.__es = { opened: [], live: 0, byUrl: {} };
    const Native = window.EventSource;
    class CountingES extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        const u = String(url);
        // @ts-expect-error
        window.__es.opened.push(u);
        // @ts-expect-error
        window.__es.live += 1;
        // @ts-expect-error
        window.__es.byUrl[u] = (window.__es.byUrl[u] || 0) + 1;
        const origClose = this.close.bind(this);
        this.close = () => {
          // @ts-expect-error
          window.__es.live -= 1;
          // @ts-expect-error
          window.__es.byUrl[u] = (window.__es.byUrl[u] || 1) - 1;
          origClose();
        };
      }
    }
    // @ts-expect-error
    window.EventSource = CountingES;
  });
}

interface ESState {
  opened: string[];
  live: number;
  byUrl: Record<string, number>;
}
async function readES(page: Page): Promise<ESState> {
  // @ts-expect-error
  return page.evaluate(() => window.__es as ESState);
}

test('Flow 1 + 2: ONE workspace EventSource with a slideover open; list live-updates through the mux', async ({
  page,
}) => {
  await instrumentEventSource(page);
  await signUpFresh(page);
  const wslug = uniq('mux-ws');
  const pslug = uniq('mux-proj');
  await createWorkspace(page, 'Mux WS', wslug);
  await createProject(page, wslug, 'Mux Proj', pslug);
  await createWorkItem(page, wslug, pslug, 'Seed Alpha', { status: 'todo' });
  await createWorkItem(page, wslug, pslug, 'Seed Bravo', { status: 'todo' });

  // Land on the work-items list view (this mounts the events consumer(s)).
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  await expect(page.getByText('Seed Alpha')).toBeVisible();
  await expect(page.getByText('Seed Bravo')).toBeVisible();

  // Open a document slideover (the old topology opened ANOTHER socket here).
  await page.getByRole('button', { name: 'Open Seed Alpha' }).click();
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  // Let any per-hook sockets settle.
  await page.waitForTimeout(1500);

  const es = await readES(page);
  const eventsUrls = es.opened.filter((u) => /\/api\/v1\/w\/[^/]+\/events/.test(u));
  const liveEventsByUrl = Object.entries(es.byUrl).filter(
    ([u, n]) => /\/api\/v1\/w\/[^/]+\/events/.test(u) && n > 0,
  );
  // FLOW 1 ASSERTION: exactly ONE live EventSource to /events (cockpit not open here).
  const liveCount = liveEventsByUrl.reduce((acc, [, n]) => acc + n, 0);
  console.log('[Flow1] events sockets opened (cumulative):', eventsUrls);
  console.log('[Flow1] live events sockets by url:', liveEventsByUrl);
  console.log('[Flow1] live /events socket count:', liveCount);
  expect(liveCount, 'exactly one live EventSource to /events with slideover open').toBe(1);

  // FLOW 2: write a new doc over the wire; the list must live-update via the mux.
  await createWorkItem(page, wslug, pslug, 'Live Charlie', { status: 'todo' });
  await expect(page.getByText('Live Charlie')).toBeVisible({ timeout: 8000 });
  console.log('[Flow2] live update delivered through the single mux socket: OK');

  // Still exactly one live socket after the update (no churn).
  const es2 = await readES(page);
  const live2 = Object.entries(es2.byUrl)
    .filter(([u, n]) => /\/api\/v1\/w\/[^/]+\/events/.test(u) && n > 0)
    .reduce((acc, [, n]) => acc + n, 0);
  expect(live2, 'still one live socket after a live update').toBe(1);
});

test('Flow 2 edge: two rapid wire writes — list converges (debounce collapses)', async ({
  page,
}) => {
  await instrumentEventSource(page);
  await signUpFresh(page);
  const wslug = uniq('deb-ws');
  const pslug = uniq('deb-proj');
  await createWorkspace(page, 'Deb WS', wslug);
  await createProject(page, wslug, 'Deb Proj', pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  await page.waitForTimeout(800);

  // Two rapid writes in the debounce window.
  await Promise.all([
    createWorkItem(page, wslug, pslug, 'Rapid One', { status: 'todo' }),
    createWorkItem(page, wslug, pslug, 'Rapid Two', { status: 'todo' }),
  ]);
  await expect(page.getByText('Rapid One')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('Rapid Two')).toBeVisible({ timeout: 8000 });
});

test('Flow 3: wiki page cards show body excerpts; empty-body page shows none', async ({ page }) => {
  await signUpFresh(page);
  const wslug = uniq('wiki-ws');
  const pslug = uniq('wiki-proj');
  await createWorkspace(page, 'Wiki WS', wslug);
  await createProject(page, wslug, 'Wiki Proj', pslug);

  // Page WITH body content.
  const withBody = await page.request.post(`/api/v1/w/${wslug}/p/${pslug}/documents`, {
    data: {
      type: 'page',
      title: 'Page With Body',
      body: 'This is the first line of the excerpt.\nAnd a second line that should also appear.',
    },
  });
  expect(withBody.ok(), `seed page-with-body ${withBody.status()}`).toBe(true);
  const withBodySlug = (await withBody.json()).data.slug;

  // Page WITHOUT body content (empty-body edge).
  const noBody = await page.request.post(`/api/v1/w/${wslug}/p/${pslug}/documents`, {
    data: { type: 'page', title: 'Page No Body', body: '' },
  });
  expect(noBody.ok(), `seed page-no-body ${noBody.status()}`).toBe(true);
  const noBodySlug = (await noBody.json()).data.slug;

  await page.goto(`/w/${wslug}/p/${pslug}/wiki`);
  await expect(page.getByText('Page With Body')).toBeVisible();
  await expect(page.getByText('Page No Body')).toBeVisible();

  // Scope to each card by its stable data-testid (wiki-card-<slug>).
  const withCard = page.locator(`[data-testid="wiki-card-${withBodySlug}"]`);
  const noCard = page.locator(`[data-testid="wiki-card-${noBodySlug}"]`);

  // The body-bearing card shows its excerpt <p class=line-clamp-2> with the text.
  await expect(withCard.locator('p.line-clamp-2')).toHaveCount(1);
  await expect(withCard.locator('p.line-clamp-2')).toContainText(
    'This is the first line of the excerpt.',
  );

  // The empty-body card shows NO excerpt <p> (graceful empty edge).
  await expect(noCard.locator('p.line-clamp-2')).toHaveCount(0);
  console.log('[Flow3] excerpt shown for body page; none for empty-body page: OK');
});

test('Flow 3 edge: empty-state wiki (no pages) loads without crash', async ({ page }) => {
  await signUpFresh(page);
  const wslug = uniq('empty-ws');
  const pslug = uniq('empty-proj');
  await createWorkspace(page, 'Empty WS', wslug);
  await createProject(page, wslug, 'Empty Proj', pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/wiki`);
  // No JS crash; an empty-state CTA is reachable.
  await expect(page.getByRole('button', { name: /Create your first page/ })).toBeVisible();
});

test('Flow 2 edge: empty list view (no docs) loads without crash', async ({ page }) => {
  await signUpFresh(page);
  const wslug = uniq('emptl-ws');
  const pslug = uniq('emptl-proj');
  await createWorkspace(page, 'EmptyL WS', wslug);
  await createProject(page, wslug, 'EmptyL Proj', pslug);
  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  // Table chrome renders even with zero rows.
  await expect(page.getByRole('tab', { name: 'Work items', exact: true })).toBeVisible();
});

test('Flow edge (mid-flow failure): offline save rolls back optimistic title + shows error toast', async ({
  page,
  context,
}) => {
  await signUpFresh(page);
  const wslug = uniq('off-ws');
  const pslug = uniq('off-proj');
  await createWorkspace(page, 'Off WS', wslug);
  await createProject(page, wslug, 'Off Proj', pslug);
  await createWorkItem(page, wslug, pslug, 'Original Title', { status: 'todo' });

  await page.goto(`/w/${wslug}/p/${pslug}/work-items`);
  await expect(page.getByText('Original Title')).toBeVisible();
  await page.getByRole('button', { name: 'Open Original Title' }).click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  // Go offline at the network layer (CDP) so the PATCH fails mid-flow.
  await context.setOffline(true);

  // Edit the title inline and commit (Enter). The optimistic update applies the
  // new title, then the PATCH fails offline → onError rolls back + toast.error.
  const titleInput = dialog.locator('input[type="text"]').first();
  // Re-enter edit mode if needed (click the title button).
  if (!(await titleInput.isVisible().catch(() => false))) {
    await dialog.getByRole('button', { name: /Edit title/ }).click();
  }
  await titleInput.fill('Offline Edit Attempt');
  await titleInput.press('Enter');

  // An error toast appears (sonner). Match the offline/network error copy loosely.
  await expect(page.locator('[data-sonner-toast]')).toBeVisible({ timeout: 8000 });

  // Recover the network and confirm the title rolled back to server truth.
  await context.setOffline(false);
  // Close the slideover and reload to read server truth.
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByText('Original Title')).toBeVisible();
  await expect(page.getByText('Offline Edit Attempt')).toHaveCount(0);
  console.log('[mid-flow] offline save: error toast shown + optimistic title rolled back: OK');
});
