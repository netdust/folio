import { test, expect } from '@playwright/test';
import { signUpFresh, createWorkspace, createProject, createWorkItem } from './fixtures.ts';

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
 *   - Board manual drag-reorder (4c): now DRIVEN below (2026-06-07 dnd fix). The
 *     prior "headless-fragile" note held because page.mouse dispatches MOUSE
 *     events, which dnd-kit's PointerSensor ignores — dispatching real
 *     PointerEvents drives the drag reliably. (The shakeout-projects spec's
 *     cross-column card drag still uses page.mouse → keep that one as eyeball.)
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

// ── Board manual within-column drag-reorder (BUG 1 + BUG 2 fix) ────────────────
//
// Previously recorded as "headless-fragile → human eyeball". The fix (DragOverlay
// + closestCorners collision) makes the within-column reorder actually register
// and persist. We attempt the REAL stepped-mouse drag here. dnd-kit needs the
// PointerSensor's 5px activation distance crossed by intermediate moves before
// the drop, so we step the pointer in several increments.
//
// If this proves flaky in headless (genuinely possible — dnd-kit + headless is
// hard), it is annotated and the gesture stays human-verified; the wired persist
// path is already proven by the kanban-view-dnd.test.tsx onDragEnd seam test.
test('board: manual within-column drag-reorder persists a new board_position', async ({
  page,
}) => {
  await signUpFresh(page);
  const wslug = `dnd-ws-${Date.now()}`;
  const pslug = 'dnd-p';
  await createWorkspace(page, 'DnD WS', wslug);
  await createProject(page, wslug, 'DnD Proj', pslug);
  // Two work items in the SAME (todo) column → a within-column reorder target.
  await createWorkItem(page, wslug, pslug, 'Card Alpha', { status: 'todo' });
  await createWorkItem(page, wslug, pslug, 'Card Bravo', { status: 'todo' });

  // Open the default board, then switch the Sort to Manual — only manual mode
  // makes the cards sortable (within-column reorder enabled). The seeded default
  // view ships with a field sort.
  await page.goto(`/w/${wslug}/p/${pslug}/board`);
  await expect(page.getByRole('button', { name: /Card Alpha/ })).toBeVisible({ timeout: 6000 });
  await page.getByRole('button', { name: /^Sort:/ }).click();
  await page.getByRole('menuitem', { name: 'Manual', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Sort:\s*Manual/ })).toBeVisible();

  // Persisted order (manual mode sorts by board_position; null coalesces last).
  const persistedOrder = async (): Promise<string[]> => {
    const res = await page.request.get(
      `/api/v1/w/${wslug}/p/${pslug}/documents?type=work_item&sort=board_position&dir=asc&limit=200`,
    );
    const rows = ((await res.json()).data ?? []) as Array<{ title: string }>;
    return rows.map((r) => r.title);
  };
  const before = await persistedOrder();
  expect(before).toHaveLength(2);

  // Drag the SECOND card above the FIRST so the order is guaranteed to change.
  const firstTitle = before[0]!;
  const secondTitle = before[1]!;
  const first = page.getByRole('button', { name: new RegExp(firstTitle) });
  const second = page.getByRole('button', { name: new RegExp(secondTitle) });

  // Diagnostic: record any document PATCH the drag triggers.
  const patches: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && req.url().includes('/documents/')) patches.push(req.url());
  });

  const srcBox = await second.boundingBox();
  const dstBox = await first.boundingBox();
  expect(srcBox && dstBox).toBeTruthy();
  const sx = srcBox!.x + srcBox!.width / 2;
  const sy = srcBox!.y + srcBox!.height / 2;
  const dx = dstBox!.x + dstBox!.width / 2;
  // Aim at the FIRST card's top quarter so closestCorners reports it as a
  // drop-before target.
  const dy = dstBox!.y + dstBox!.height * 0.25;

  // dnd-kit's PointerSensor listens for POINTER events (not mouse), so we
  // dispatch real PointerEvents on the source element and walk to the target.
  // page.mouse synthesizes mouse events which the sensor ignores.
  await second.evaluate(
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
  // Walk the pointer to the target in steps; dispatch on document so the
  // sensor's window-level listeners pick them up.
  const stepN = 10;
  let midDragOverlayCount = 0;
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
    await page.waitForTimeout(25);
    // BUG 1 proof: mid-drag, the dragged card's title appears TWICE — the dimmed
    // in-place card + the DragOverlay clone (which portals to <body>, escaping
    // the column's overflow clip so it paints ON TOP instead of behind). Capture
    // the max seen across steps + a screenshot for the eyeball record.
    if (i === Math.ceil(stepN / 2)) {
      midDragOverlayCount = await page.getByText(secondTitle, { exact: true }).count();
      await page.screenshot({ path: 'test-results/kanban-drag-overlay.png' });
    }
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

  // BUG 1 proof: the DragOverlay clone was present mid-drag (2 instances of the
  // dragged card's title) — it portals above the columns, no longer clipped.
  expect(midDragOverlayCount, 'DragOverlay clone should render the dragged card mid-drag').toBeGreaterThanOrEqual(2);

  // OPTIMISTIC-ORDER proof (the snap-back fix, 2026-06-07): immediately after
  // drop — BEFORE the onSettled refetch lands (~400ms) — the ON-SCREEN card
  // order must already show the dragged card first. Previously the optimistic
  // cache patched the card in place WITHOUT re-sorting, so the card sat in its
  // old slot (and its underlying node animated back to origin) until the refetch
  // re-ordered it. We read the DOM order of the card buttons and poll a SHORT
  // window — this would still be the OLD order at this point without Fix B.
  const onScreenOrder = async (): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="button"]'))
        .map((el) => (el.textContent ?? '').trim())
        .filter((t) => t === 'Card Alpha' || t === 'Card Bravo'),
    );
  await expect(async () => {
    const order = await onScreenOrder();
    // The dragged (formerly second) card now renders first, optimistically.
    expect(order[0]).toBe(secondTitle);
  }).toPass({ timeout: 1500 });

  // BUG 2 proof: the drag fired a board_position PATCH (within-column reorder
  // now registers), AND the persisted order flipped so the dragged (formerly
  // second) card is now first. Poll (optimistic UI + async PATCH).
  expect(patches.length, 'a within-column drag should PATCH board_position').toBeGreaterThan(0);
  await expect(async () => {
    const after = await persistedOrder();
    expect(after[0]).toBe(secondTitle);
  }).toPass({ timeout: 8000 });
});

// ── ISSUE 1: auto-switch to Manual on a sorted-mode reorder-intent drag ────────
//
// The board DEFAULTS to a field sort (e.g. Updated ↓). A within-column card-over-
// card drag is a hand-reorder intent the sort can't express, and previously did
// NOTHING (no PATCH, no feedback). The fix: such a drop flips Sort→Manual (live
// bus + persisted sort:[]) AND applies the board_position reorder. This drives
// the FULL flow in the real browser — NO manual Sort switch first.
test('board: a sorted-mode within-column drag auto-switches Sort to Manual and reorders', async ({
  page,
}) => {
  await signUpFresh(page);
  const wslug = `auto-ws-${Date.now()}`;
  const pslug = 'auto-p';
  await createWorkspace(page, 'Auto WS', wslug);
  await createProject(page, wslug, 'Auto Proj', pslug);
  await createWorkItem(page, wslug, pslug, 'Card Alpha', { status: 'todo' });
  await createWorkItem(page, wslug, pslug, 'Card Bravo', { status: 'todo' });

  // Open the DEFAULT board — do NOT switch to Manual. The seeded default view
  // ships with a non-null (field) sort, so the board starts in sorted mode.
  await page.goto(`/w/${wslug}/p/${pslug}/board`);
  await expect(page.getByRole('button', { name: /Card Alpha/ })).toBeVisible({ timeout: 6000 });
  // Precondition: the Sort is NOT already Manual.
  await expect(page.getByRole('button', { name: /^Sort:/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sort:\s*Manual/ })).toHaveCount(0);

  // Record document PATCHes (the reorder) and view PATCHes (the auto-switch persist).
  const docPatches: string[] = [];
  const viewPatches: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'PATCH') return;
    if (req.url().includes('/documents/')) docPatches.push(req.url());
    if (req.url().includes('/views/')) viewPatches.push(req.url());
  });

  // Drag the SECOND card onto the FIRST — a same-column card-over-card reorder
  // intent. dnd-kit's PointerSensor listens for POINTER events, so dispatch real
  // PointerEvents (page.mouse synthesizes mouse events the sensor ignores).
  const second = page.getByRole('button', { name: /Card Bravo/ });
  const first = page.getByRole('button', { name: /Card Alpha/ });
  const srcBox = await second.boundingBox();
  const dstBox = await first.boundingBox();
  expect(srcBox && dstBox).toBeTruthy();
  const sx = srcBox!.x + srcBox!.width / 2;
  const sy = srcBox!.y + srcBox!.height / 2;
  const dx = dstBox!.x + dstBox!.width / 2;
  const dy = dstBox!.y + dstBox!.height * 0.25;

  await second.evaluate(
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
  const stepN = 10;
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
    await page.waitForTimeout(25);
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

  // (a) the toolbar Sort label flipped to Manual (the bus override the auto-
  // switch set is read by the toolbar). This is the user-visible feedback that
  // was MISSING before.
  await expect(page.getByRole('button', { name: /Sort:\s*Manual/ })).toBeVisible({ timeout: 6000 });

  // (b) the auto-switch was PERSISTED (a view PATCH fired) AND the reorder was
  // applied (a board_position document PATCH fired).
  expect(viewPatches.length, 'auto-switch should persist sort:[] via a view PATCH').toBeGreaterThan(0);
  expect(docPatches.length, 'reorder should PATCH board_position').toBeGreaterThan(0);

  // (c) the persisted order flipped — the dragged (formerly second) card lands first.
  await expect(async () => {
    const res = await page.request.get(
      `/api/v1/w/${wslug}/p/${pslug}/documents?type=work_item&sort=board_position&dir=asc&limit=200`,
    );
    const rows = ((await res.json()).data ?? []) as Array<{ title: string }>;
    expect(rows[0]?.title).toBe('Card Bravo');
  }).toPass({ timeout: 8000 });
});
