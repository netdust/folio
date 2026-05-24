import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const path = '/api/v1/w/acme/p/web/fields';

test('GET / empty initially', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('POST creates a select field with options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'select', options: ['low', 'med', 'high'] }),
  });
  expect(res.status).toBe(201);
});

test('POST 422 when select has no options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'select' }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_BODY');
});

test('POST 422 when text has options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'note', type: 'text', options: ['x'] }),
  });
  expect(res.status).toBe(422);
});

test('PATCH type change preserves row', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'string' }),
  });
  const { data: { field } } = await create.json();
  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'text' }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).data.field.type).toBe('text');
});

test('DELETE drops the pin', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'string' }),
  });
  const { data: { field } } = await create.json();
  const res = await app.request(`${path}/${field.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('POST /fields accepts type=currency with a single ISO-4217 option', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency', options: ['EUR'] }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  const field = body.data?.field ?? body.data ?? body.field;
  expect(field.type).toBe('currency');
  expect(field.options).toEqual(['EUR']);
});

test('POST /fields 422 on currency without options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency' }),
  });
  expect(res.status).toBe(422);
});

test('POST /fields 422 on currency with non-ISO code', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency', options: ['euro'] }),
  });
  expect(res.status).toBe(422);
});
