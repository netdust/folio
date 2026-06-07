import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const path = '/api/v1/w/acme/p/web/documents';

async function createWorkItem(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  title: string,
): Promise<string> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.slug as string;
}

test('GET /documents?sort=title&dir=asc orders by title ascending', async () => {
  const { app, seed } = await makeTestApp();
  const cookie = seed.sessionCookie;
  await createWorkItem(app, cookie, 'Charlie');
  await createWorkItem(app, cookie, 'Alpha');
  await createWorkItem(app, cookie, 'Bravo');

  const res = await app.request(`${path}?type=work_item&sort=title&dir=asc`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const titles = body.data.map((d: { title: string }) => d.title);
  expect(titles).toEqual([...titles].sort());
  expect(titles).toEqual(['Alpha', 'Bravo', 'Charlie']);
});

// Blind-spot close (hardening): 4c's manual Kanban ordering depends on the
// SERVER coalescing unranked (board_position IS NULL) work_items to LAST when
// `sort=board_position&dir=asc` (the params KanbanView sends in manual mode).
// The client assumes ranked cards lead and unranked trail; no server test pinned
// that contract. listDocuments coalesces null → the max-BMP NULL_SENTINEL in the
// ORDER BY, so 'a0' < 'a5' < null. If the server stopped coalescing (nulls sort
// first under SQLite's NULLS-FIRST default), manual boards would silently
// reorder unranked cards to the top — this would go RED.
async function patchBoardPosition(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  slug: string,
  position: string,
): Promise<void> {
  const res = await app.request(`${path}/${slug}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardPosition: position }),
  });
  expect(res.status).toBe(200);
}

test('GET ?sort=board_position&dir=asc sorts ranked first (a0,a5) and unranked (null) LAST', async () => {
  const { app, seed } = await makeTestApp();
  const cookie = seed.sessionCookie;
  // Two ranked + one deliberately unranked (board_position stays null).
  const ranked0 = await createWorkItem(app, cookie, 'Ranked Zero');
  const ranked5 = await createWorkItem(app, cookie, 'Ranked Five');
  await createWorkItem(app, cookie, 'Unranked');
  await patchBoardPosition(app, cookie, ranked0, 'a0');
  await patchBoardPosition(app, cookie, ranked5, 'a5');

  const res = await app.request(`${path}?type=work_item&sort=board_position&dir=asc`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const titles = body.data.map((d: { title: string }) => d.title);
  // Ranked docs lead in rank order; the unranked (null) doc trails.
  expect(titles).toEqual(['Ranked Zero', 'Ranked Five', 'Unranked']);
});

test('GET /documents with no sort defaults to updated_at desc', async () => {
  const { app, seed } = await makeTestApp();
  const cookie = seed.sessionCookie;
  await createWorkItem(app, cookie, 'First');
  await createWorkItem(app, cookie, 'Second');
  const lastSlug = await createWorkItem(app, cookie, 'Third');

  // Touch "Third" last so its updated_at is strictly the most recent — this
  // makes the default ordering deterministic regardless of insert-time ms
  // collisions or id ordering.
  const patch = await app.request(`${path}/${lastSlug}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { touched: true } }),
  });
  expect(patch.status).toBe(200);

  const res = await app.request(`${path}?type=work_item`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data[0].title).toBe('Third');
});
