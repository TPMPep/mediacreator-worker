// =============================================================================
// ENV — Centralized env-var parsing with sensible defaults.
// Fail fast on missing required values; never silently fall back.
// =============================================================================

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[env] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function optional(name: string, def: string): string {
  return process.env[name] || def;
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export const env = {
  UPSTASH_REDIS_URL: required('UPSTASH_REDIS_URL'),
  BASE44_APP_ID: required('BASE44_APP_ID'),
  BASE44_API_BASE: optional('BASE44_API_BASE', 'https://app.base44.com/api/apps'),
  BASE44_SERVICE_TOKEN: required('BASE44_SERVICE_TOKEN'),

  SENTRY_BACKEND_DSN: process.env.SENTRY_BACKEND_DSN || '',
  SENTRY_ENVIRONMENT: optional('SENTRY_ENVIRONMENT', 'production'),
  SENTRY_RELEASE: process.env.SENTRY_RELEASE || undefined,

  CONCURRENCY_VOICE_GEN: intEnv('WORKER_CONCURRENCY_VOICE_GEN', 5),
  CONCURRENCY_TRANSLATE: intEnv('WORKER_CONCURRENCY_TRANSLATE', 10),
  CONCURRENCY_ENRICH: intEnv('WORKER_CONCURRENCY_ENRICH', 4),
  CONCURRENCY_SRT_IMPORT: intEnv('WORKER_CONCURRENCY_SRT_IMPORT', 2),

  ENQUEUE_PORT: intEnv('WORKER_ENQUEUE_PORT', 3000),
  ENQUEUE_SECRET: process.env.WORKER_ENQUEUE_SECRET || '',
};