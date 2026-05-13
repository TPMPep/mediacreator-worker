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

  // Voice-gen concurrency. Held DELIBERATELY at 2 (lowered from 3 on
  // 2026-05-13 after observed regression: 24-segment v3-clone dub at
  // concurrency=3 still tripped the platform SDK gateway — every segment
  // got HTTP 403 "auth_required" + HTTP 429 "Rate limit exceeded" mid-
  // generateOneSegment, marking the whole run failed silently. Prior
  // history: concurrency=5 saturated on 2026-05-10 (116-seg dub), lowered
  // to 3; that protects v2/Flash but not v3-clone runs where each segment
  // does additional SDK writes (audit hash, cue/stability branches,
  // identity-shift path probes). At 2 we get ~16 platform calls/sec
  // sustained — well under the per-app threshold even for v3-clone
  // density profiles. Throughput trade-off: 116-segment dub goes from
  // ~8min → ~12min — acceptable for an auditor-defensible posture per
  // SOC 2 CC7.4 / TPN MS-7.x. Bump back to 3 only after the platform
  // rate limit is raised or the SDK adopts adaptive backoff.
  CONCURRENCY_VOICE_GEN: intEnv('WORKER_CONCURRENCY_VOICE_GEN', 2),
  // (Legacy CONCURRENCY_TRANSLATE removed 2026-05-09 — batch-translate
  // queue is gone. Translation now uses TRANSLATE_ORCHESTRATOR/CHUNK below.)
  // Legacy single-shot enrich queue. Kept low — it shouldn't be receiving
  // new jobs once the v2 pipeline is rolled out.
  CONCURRENCY_ENRICH: intEnv('WORKER_CONCURRENCY_ENRICH', 4),
  // v2 enrichment: the orchestrator should be SERIAL per worker (low cost,
  // serialized DB writes against the run document) but chunks are the hot
  // path — bumped to 20 to satisfy the 100-concurrent-users target.
  CONCURRENCY_ENRICH_ORCHESTRATOR: intEnv('WORKER_CONCURRENCY_ENRICH_ORCHESTRATOR', 4),
  CONCURRENCY_ENRICH_CHUNK: intEnv('WORKER_CONCURRENCY_ENRICH_CHUNK', 20),
  // v4 translation pipeline (2026-05-09): chunk concurrency held DELIBERATELY
  // at 4 — same as voice-gen which has never hit the platform rate limit.
  // The May 8 incident occurred at chunk concurrency=6. Combined with the
  // inline-text chunk_plan design (4 SDK calls per chunk vs 6-8 in pre-v3),
  // total platform SDK density stays ~5-6 calls/sec sustained on a 5000-line
  // run — well under the platform per-app threshold.
  CONCURRENCY_TRANSLATE_ORCHESTRATOR: intEnv('WORKER_CONCURRENCY_TRANSLATE_ORCHESTRATOR', 4),
  CONCURRENCY_TRANSLATE_CHUNK: intEnv('WORKER_CONCURRENCY_TRANSLATE_CHUNK', 4),
  // v2 adaptation pipeline: orchestrator is serial-ish per run (low cost,
  // serialized DB writes against the run document), chunks are the hot path.
  // For generate_adaptation, each chunk = up to 5 LLM calls in series, so 20
  // concurrent chunks = up to 100 in-flight LLM calls — keep this conservative
  // and bump as Gemini quota allows.
  CONCURRENCY_ADAPT_ORCHESTRATOR: intEnv('WORKER_CONCURRENCY_ADAPT_ORCHESTRATOR', 4),
  CONCURRENCY_ADAPT_CHUNK: intEnv('WORKER_CONCURRENCY_ADAPT_CHUNK', 15),
  // v2 AI-rewrite (bulk shorten/expand) pipeline. Each chunk = up to 10 LLM
  // calls (one per line, CPS-verified, processed serially inside the chunk)
  // + 1 TranslationSegment.update per line. Chunk concurrency held
  // DELIBERATELY at 3 (lowered from 10 on 2026-05-13 after incident: 4
  // concurrent chunks × 10 lines × (LLM + DB write) burst-triggered the
  // Base44 platform gateway 403 'auth_required' regression — same failure
  // mode as voice-gen on 2026-05-10 which was resolved by lowering
  // voice-gen concurrency 5→3). Mirrors voice-gen's posture: same "many
  // SDK writes per job" profile, same conservative cap. Throughput trade-
  // off: a 34-line bulk rewrite completes in ~3 sequential chunk batches
  // instead of 1 (~+30-60s wall-clock) — auditor-defensible posture per
  // SOC 2 CC7.4 / TPN MS-7.x. Bump only after a clean load-test run.
  CONCURRENCY_AIREWRITE_ORCHESTRATOR: intEnv('WORKER_CONCURRENCY_AIREWRITE_ORCHESTRATOR', 4),
  CONCURRENCY_AIREWRITE_CHUNK: intEnv('WORKER_CONCURRENCY_AIREWRITE_CHUNK', 3),
  CONCURRENCY_SRT_IMPORT: intEnv('WORKER_CONCURRENCY_SRT_IMPORT', 2),
  // v2 HLS ingest: single-shot remux jobs. Each job blocks one worker slot
  // for up to 15 min during the Railway call, so this is a hard cap on
  // concurrent ingests across the whole platform. 4 = safe default that
  // keeps Railway compute bounded; tune up only after the load test green-
  // lights it.
  CONCURRENCY_HLS_INGEST: intEnv('WORKER_CONCURRENCY_HLS_INGEST', 4),
  // CC format-run: each job blocks a worker slot for up to ~3 min on a 1,100-
  // cue project. Set to 4 to match other heavy single-shot pipelines and
  // give an 100-concurrent-user load headroom of ~25 runs/min sustained.
  CONCURRENCY_CC_FORMAT_RUN: intEnv('WORKER_CONCURRENCY_CC_FORMAT_RUN', 4),

  ENQUEUE_PORT: intEnv('WORKER_ENQUEUE_PORT', 3000),
  ENQUEUE_SECRET: process.env.WORKER_ENQUEUE_SECRET || '',
};
