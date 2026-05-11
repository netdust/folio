import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { jsonOk, jsonError, HTTPError, registerErrorHandler } from './http.ts';

test('jsonOk wraps in { data }', async () => {
  const app = new Hono();
  app.get('/x', (c) => jsonOk(c, { hello: 'world' }));
  const res = await app.request('/x');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { hello: 'world' } });
});

test('jsonError wraps in { error: { code, message } }', async () => {
  const app = new Hono();
  app.get('/x', (c) => jsonError(c, 'NOT_FOUND', 'nope', 404));
  const res = await app.request('/x');
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'nope' } });
});

test('HTTPError thrown inside handler is rendered by registered error handler', async () => {
  const app = new Hono();
  registerErrorHandler(app);
  app.get('/x', () => { throw new HTTPError('SLUG_CONFLICT', 'taken', 409); });
  const res = await app.request('/x');
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: { code: 'SLUG_CONFLICT', message: 'taken' } });
});
