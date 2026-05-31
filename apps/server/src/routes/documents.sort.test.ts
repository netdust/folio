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
