import { Hono } from 'hono';

export const healthRoute = new Hono();

healthRoute.get('/healthz', (c) => c.json({ ok: true, version: '0.0.1' }));
