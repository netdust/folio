/**
 * Phase 2.5: workspace agents end-to-end.
 *
 * Verifies the full vertical: workspace popover → Agents page → create agent
 * with a narrowed allow-list → confirm the assignee picker honors the
 * allow-list across two projects.
 */
import { test, expect, signUpFresh, createWorkspace, createProject } from './fixtures.ts';

test('workspace agents flow: create narrowed agent, assignee picker filters by project', async ({ page }) => {
  await signUpFresh(page);
  await createWorkspace(page, 'Phase 2.5 WS', 'p25');
  // Two projects so we can prove the filter actually narrows.
  await createProject(page, 'p25', 'Inbox', 'inbox');
  await createProject(page, 'p25', 'Website', 'website');

  // Resolve project ids — needed for the agent's `projects:` allow-list.
  const projectsRes = await page.request.get('/api/v1/w/p25/projects');
  expect(projectsRes.ok()).toBe(true);
  const projectsBody = await projectsRes.json();
  const projects = projectsBody.data as { id: string; slug: string }[];
  const inboxId = projects.find((p) => p.slug === 'inbox')!.id;

  // Create a workspace agent allow-listed for Inbox only.
  const createRes = await page.request.post('/api/v1/w/p25/documents', {
    data: {
      type: 'agent',
      title: 'Inbox Triager',
      frontmatter: {
        system_prompt: 'Triage incoming items.',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        tools: ['list_documents'],
        projects: [inboxId],
      },
    },
  });
  expect(createRes.ok(), `create agent → ${createRes.status()}`).toBe(true);
  const agentDoc = (await createRes.json()).data;
  expect(agentDoc.frontmatter.projects).toEqual([inboxId]);
  expect(agentDoc.projectId).toBeNull();

  // Workspace agents page lists it.
  await page.goto('/w/p25/agents');
  await expect(page.getByText('Inbox Triager')).toBeVisible({ timeout: 10_000 });
  // The "Inbox" chip should be visible alongside (or just below) the agent row.
  await expect(page.getByText('Inbox').first()).toBeVisible();

  // Project A (Inbox): the assignee picker should surface this agent.
  // Create a work item first so we have a row to open.
  const wiInbox = await page.request.post('/api/v1/w/p25/p/inbox/documents', {
    data: { type: 'work_item', title: 'Sample inbox item' },
  });
  expect(wiInbox.ok()).toBe(true);

  // FrontmatterForm is key-driven (no `assignee` key → no picker), and the
  // workspace slideover pins no fields. An empty-string assignee is STRIPPED on
  // write (documents.ts: `'' → clear`), so seed a NON-EMPTY placeholder value so
  // the key persists and the AssigneePicker renders. PATCH before navigating so
  // we don't have to reload + reopen.
  const wiInboxDoc = await wiInbox.json();
  const inboxSlug = wiInboxDoc.data.slug as string;
  await page.request.patch(`/api/v1/w/p25/p/inbox/documents/${inboxSlug}`, {
    data: { frontmatter: { assignee: 'unset' } },
  });

  // Open the slideover via the row's accessible "Open <title>" button —
  // clicking the row's title text would trigger InlineEdit instead.
  await page.goto('/w/p25/p/inbox/work-items');
  await page.getByRole('button', { name: 'Open Sample inbox item' }).click();

  // The assignee row's button shows the current value ('unset') and opens a
  // Popover with Members + Agents. Open it.
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: 'unset', exact: true }).click();
  // Agent IS allow-listed for inbox → it should appear in the Agents section.
  await expect(page.getByText('Inbox Triager').last()).toBeVisible({ timeout: 5_000 });

  // Project B (Website): the agent must NOT appear.
  const wiWebsite = await page.request.post('/api/v1/w/p25/p/website/documents', {
    data: { type: 'work_item', title: 'Sample website item', frontmatter: { assignee: 'unset' } },
  });
  expect(wiWebsite.ok()).toBe(true);
  await page.goto('/w/p25/p/website/work-items');
  await page.getByRole('button', { name: 'Open Sample website item' }).click();
  await page.locator('[role="dialog"]').getByRole('button', { name: 'unset', exact: true }).click();
  // The agent should not be in the picker for website.
  await expect(page.getByText('Inbox Triager')).toHaveCount(0);
});
