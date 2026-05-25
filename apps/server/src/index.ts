import { app } from './app.ts';
import { env } from './env.ts';

console.log(`[folio] listening on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
