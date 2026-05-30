/**
 * Phase 3 (Sub-phase F) — real-Anthropic end-to-end.
 *
 * Inert by default. Set FOLIO_TEST_ANTHROPIC_KEY to run it against the live
 * Anthropic API (BYOK). It costs a tiny number of tokens (one haiku reply).
 *
 *   FOLIO_TEST_ANTHROPIC_KEY=sk-ant-... bun run e2e -- phase-3-real-anthropic
 *
 * What it proves: configure the workspace Anthropic key through the AI
 * settings UI → assign a work_item to a reply-drafter agent → the
 * builtin-on-assignment trigger fires the runner → the runner calls Anthropic
 * → a `kind=result` comment lands on the parent work_item.
 *
 * --- Why the key is typed into the UI, not threaded into the server env ---
 * The AI key is workspace-scoped BYOK: the AI settings tab POSTs it to
 * `/api/v1/w/:wslug/ai/keys`, where it is libsodium-encrypted at rest with the
 * server's FOLIO_MASTER_KEY (set in playwright.config.ts) and decrypted by the
 * runner when it makes the outbound call. The server therefore needs NO
 * provider-key env var of its own — it reads the workspace's stored key. So we
 * deliberately do NOT add FOLIO_TEST_ANTHROPIC_KEY to the `webServer` API env;
 * the test reads it only to type into the UI. (Confirmed against
 * apps/server/src/routes/settings.ts + lib/crypto.ts: keys are per-workspace
 * encrypted rows, never an env default — the BYOK rule.)
 */
import { test, expect, signUpFresh, createWorkspace, createProject } from './fixtures.ts';

const ANTHROPIC_KEY = process.env.FOLIO_TEST_ANTHROPIC_KEY;

// Inert in CI / without a key. The whole file's single test skips.
test.skip(!ANTHROPIC_KEY, 'set FOLIO_TEST_ANTHROPIC_KEY to run');

test('configure Anthropic key in UI, assign agent, run posts a kind=result comment', async ({
  page,
}) => {
  // A real run + an outbound LLM call: give it generous headroom over the
  // 30s default. The poller claims planning rows ~every 1s; haiku is fast.
  test.setTimeout(120_000);

  await signUpFresh(page);
  await createWorkspace(page, 'Phase 3 Real', 'p3real');
  await createProject(page, 'p3real', 'Inbox', 'inbox');

  // Resolve the project id for the agent's `projects:` allow-list.
  const projectsRes = await page.request.get('/api/v1/w/p3real/projects');
  expect(projectsRes.ok()).toBe(true);
  const projects = (await projectsRes.json()).data as { id: string; slug: string }[];
  const inboxId = projects.find((p) => p.slug === 'inbox')!.id;

  // --- 1. Configure the Anthropic key via the AI settings UI ---
  await page.goto('/w/p3real/settings?tab=ai');

  // The AI tab inputs use aria-labels (see components/settings/ai-tab.tsx).
  // Provider defaults to anthropic; force it to be explicit anyway.
  await page.getByLabel('Provider').selectOption('anthropic');
  await page.getByLabel('Model').fill('claude-haiku-4-5');
  await page.getByLabel('API key').fill(ANTHROPIC_KEY as string);
  // Save key (button label flips to "Saving…" while pending).
  await page.getByRole('button', { name: 'Save key' }).click();
  // Configured-keys list shows the saved default row.
  await expect(page.getByText(/✓ default saved/)).toBeVisible({ timeout: 10_000 });

  // --- 2. Create a reply-drafter agent allow-listed for Inbox ---
  const createAgentRes = await page.request.post('/api/v1/w/p3real/documents', {
    data: {
      type: 'agent',
      title: 'Reply Drafter',
      frontmatter: {
        system_prompt: 'Reply in one short sentence in English.',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        tools: [],
        projects: [inboxId],
      },
    },
  });
  expect(createAgentRes.ok(), `create agent → ${createAgentRes.status()}`).toBe(true);
  const agentDoc = (await createAgentRes.json()).data;
  const agentSlug = agentDoc.slug as string;

  // --- 3. Create a work_item, seed an empty assignee so the picker renders ---
  const wiRes = await page.request.post('/api/v1/w/p3real/p/inbox/documents', {
    data: { type: 'work_item', title: 'Draft a reply', frontmatter: { assignee: '' } },
  });
  expect(wiRes.ok()).toBe(true);

  // --- 4. Assign the work_item to the agent via the slideover picker ---
  // Assigning through the UI fires builtin-on-assignment, which the runner
  // poller adopts (a human-originated assignment — the autonomy gate allows it).
  await page.goto('/w/p3real/p/inbox/work-items');
  await page.getByRole('button', { name: 'Open Draft a reply' }).click();

  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: /unassigned/i }).click();
  // The Agents section of the picker lists allow-listed agents by title.
  await page.getByText('Reply Drafter').last().click();

  // --- 5. Open the Comments tab and wait for the kind=result comment ---
  // KindChip renders `kind` verbatim for non-comment/non-error kinds, so a
  // `kind=result` comment shows the literal text "result" (see
  // components/comments/comment-row.tsx::KindChip).
  await dialog.getByRole('tab', { name: /Comments/ }).click();

  await expect(dialog.getByText('result', { exact: true }).first()).toBeVisible({
    timeout: 90_000,
  });

  // The run that produced it should be visible on the agent's Runs tab too.
  // (Open the agent slideover; its Runs tab lists the agent's run history.)
  await page.goto(`/w/p3real/agents?doc=${agentSlug}`);
  const agentDialog = page.locator('[role="dialog"]');
  await agentDialog.getByRole('tab', { name: /Runs/ }).click();
  // At least one completed run row for this agent.
  await expect(agentDialog.getByText(/completed/i).first()).toBeVisible({ timeout: 30_000 });
});
