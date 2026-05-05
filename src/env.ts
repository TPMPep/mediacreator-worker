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
  // NOTE: must use the app subdomain (.app), not the platform domain (.com).
  // The platform domain returns HTTP 403 "Backend functions cannot be accessed
  // from the platform domain. Use the app's subdomain instead."
  BASE44_API_BASE: optional('BASE44_API_BASE', 'https://app.base44.app/api/apps'),
  // BASE44_SERVICE_TOKEN intentionally removed — we now use scoped per-job JWTs
  // forwarded from the producer via job.data.auth_token. See base44-client.ts
  // and the AUTH MODEL section there for the security rationale.

  SENTRY_BACKEND_DSN: process.env.SENTRY_BACKEND_DSN || '',
  SENTRY_ENVIRONMENT: optional('SENTRY_ENVIRONMENT', 'production'),
  SENTRY_RELEASE: process.env.SENTRY_RELEASE || undefined,

  CONCURRENCY_VOICE_GEN: intEnv('WORKER_CONCURRENCY_VOICE_GEN', 5),
  CONCURRENCY_TRANSLATE: intEnv('WORKER_CONCURRENCY_TRANSLATE', 10),
  // Legacy single-shot enrich queue. Kept low — it shouldn't be receiving
  // new jobs once the v2 pipeline is rolled out.
  CONCURRENCY_ENRICH: intEnv('WORKER_CONCURRENCY_ENRICH', 4),
  // v2 enrichment: the orchestrator should be SERIAL per worker (low cost,
  // serialized DB writes against the run document) but chunks are the hot
  // path — bumped to 20 to satisfy the 100-concurrent-users target.
  CONCURRENCY_ENRICH_ORCHESTRATOR: intEnv('WORKER_CONCURRENCY_ENRICH_ORCHESTRATOR', 4),
  CONCURRENCY_ENRICH_CHUNK: intEnv('WORKER_CONCURRENCY_ENRICH_CHUNK', 20),
  CONCURRENCY_SRT_IMPORT: intEnv('WORKER_CONCURRENCY_SRT_IMPORT', 2),

  ENQUEUE_PORT: intEnv('WORKER_ENQUEUE_PORT', 3000),
  ENQUEUE_SECRET: process.env.WORKER_ENQUEUE_SECRET || '',
};