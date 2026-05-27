import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().default('file:./folio.db'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  FOLIO_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'FOLIO_MASTER_KEY must be 64 hex chars (32 bytes)'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Folio <no-reply@example.com>'),
  // Allow-list reconciler poll interval. Floor at 60s to prevent accidental
  // DoS via a mis-set env var. Default 1h is fine — the project-delete cascade
  // is the primary cleanup, this is the safety net.
  FOLIO_RECONCILER_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
