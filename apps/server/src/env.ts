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
  // Reaction Plane (Task C-10b) — durable event dispatcher poll cadence + the
  // max events drained per reactor per tick. Floor the interval at 100ms to
  // avoid a busy-loop from a mis-set env var.
  FOLIO_DISPATCHER_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  FOLIO_DISPATCHER_BATCH: z.coerce.number().int().min(1).default(100),
  // Reaction Plane (Task C-12) — runner poller. The poller claims `planning`
  // agent_run rows and dispatches them to the runner, bounded by a concurrency
  // cap, recovering orphaned `running` rows once on boot. Floor the interval at
  // 100ms to avoid a busy-loop from a mis-set env var; floor the stale
  // threshold at 10s so a mis-set value can't fail genuinely-active runs.
  FOLIO_POLLER_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  FOLIO_POLLER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  FOLIO_WORKER_STALE_MS: z.coerce.number().int().min(10_000).default(300_000),
  // I2/I3 (Phase-3 shake-out) — runner rate-limit + chain guards. Previously
  // read inline as `Number(process.env.X ?? default)` in runner.ts's security
  // pre-flight, bypassing this validated singleton: a typo'd value silently
  // became NaN in the guard path, and the defaults were duplicated in string
  // literals. Validated here like every other knob; `.min(1)` floors prevent a
  // mis-set value from disabling a cap.
  FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE: z.coerce.number().int().min(1).default(100),
  FOLIO_MAX_RUNS_PER_HOUR_PER_AGENT: z.coerce.number().int().min(1).default(50),
  FOLIO_MAX_CHAIN_FANOUT: z.coerce.number().int().min(1).default(25),
  // Floor at 1000ms (not 1): this is a duration in MILLISECONDS, and a 1..999
  // floor would silently accept a unit-confusion mis-set (e.g. `=60` meaning
  // "60s") that trips chain_duration_exceeded almost immediately. 1s is the
  // smallest meaningful cap. (Mirrors how the interval/stale knobs floor at a
  // meaningful unit rather than 1.)
  FOLIO_MAX_CHAIN_DURATION_MS: z.coerce.number().int().min(1000).default(30 * 60_000),
  FOLIO_MAX_CHAIN_TOKENS: z.coerce.number().int().min(1).default(200_000),
  // V1 autonomy gate (Task C-11). When OFF (the default), the trigger-matcher
  // refuses to fan out agent-ORIGINATED chains: an agent's own @mention/comment
  // creates ZERO runs + one `agent.chain.suppressed` signal. Human-originated
  // assignments/mentions still fire. NOTE: `z.coerce.boolean()` treats ANY
  // non-empty string as true (so 'false' → true), which is wrong — use an
  // explicit string→boolean transform so 'false' and unset both yield false.
  FOLIO_AGENT_CHAINS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
