import { Hono } from 'hono';
import { jsonOk } from '../lib/http.ts';

export const healthRoute = new Hono();

healthRoute.get('/healthz', (c) => jsonOk(c, { ok: true, version: '0.0.1' }));
