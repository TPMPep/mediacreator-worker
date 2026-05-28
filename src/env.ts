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
  // Full base URL for Base44 functions (used by processors that call back to
  // finalize steps, e.g. project-cascade calling projectCascadeWorkerStep).
  // Derived from BASE44_API_BASE + BASE44_APP_ID if not set explicitly.
  BASE44_FUNCTION_URL: process.env.BASE44_FUNCTION_URL ||
    `https://app.base44.app/api/apps/${process.env.BASE44_APP_ID}/functions`,
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
  // v2 voice-gen orchestrator concurrency (2026-05-18). The orchestrator
  // dispatches per-segment jobs in bounded ticks — it does NOT itself call
  // ElevenLabs or do any TTS work, so this knob is about how many
  // simultaneous voice-gen RUNS we orchestrate. 4 matches the other
  // orchestrators (translate, adapt, airewrite) and gives 100-user
  // concurrent-dub headroom.
  CONCURRENCY_VOICE_GEN_ORCHESTRATOR: intEnv('WORKER_CONCURRENCY_VOICE_GEN_ORCHESTRATOR', 4),
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
  // Stage 2 provider-tail tuning (2026-05-24): default lowered 5 → 3. The
  // 2026-05-21 5/replica × 4 replicas = 20 effective concurrency was the
  // correct ceiling for orchestrator throughput, but the N=10 smoke run on
  // 2026-05-24 (LoadTestRun 6a13372f...) showed Gemini Flash tail-latency
  // exceeded the per-chunk retry budget at that fan-out (367 DLQ landings,
  // p99 chunk latency 29.8 min). 3/replica × 4 replicas = 12 effective
  // concurrency reduces the simultaneous provider call burst, which directly
  // reduces stacked tail-latency without changing chunk size or retry policy.
  // Combined with the 50s → 90s per-call timeout bump in rewriteChunk and
  // the 4 → 6 BullMQ chunk attempts bump in orchestrateAIRewriteRun, this
  // is the three-lever provider-pressure relief for the next N=10 smoke.
  // SOC 2 CC7.4 — every concurrency knob traces to a real load-test
  // observation. Revertable in <60s by raising the env var.
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
  // Proxy-gen (2026-05-14): single-shot ffmpeg transcode jobs. Each job
  // blocks one worker slot for up to 3.5hr during the Railway call AND
  // pegs the Railway dyno's CPU at 100% with a hard 720p H.264 encode.
  // Concurrency held DELIBERATELY at 1 — two simultaneous transcodes on
  // the same Railway dyno would each take ~2× wall-clock and risk OOM.
  // Tune up only after Railway is scaled to a multi-replica deployment.
  CONCURRENCY_PROXY_GEN: intEnv('WORKER_CONCURRENCY_PROXY_GEN', 1),
  // Project cascade (lowered 2 → 1 on 2026-05-26 after rate-limit incident).
  // The worker step now uses the audited rate-aware delete pattern
  // (_lib_rateAwareDelete.js) which is SERIAL per cascade at the platform's
  // measured ~2 deletes/sec ceiling. Two concurrent cascades would double
  // the SDK pressure and re-trigger the 429 storm that killed the previous
  // implementation (every bulk delete of source-missing projects failed
  // with "Rate limit exceeded" until DLQ). Single-cascade-at-a-time is
  // also consistent with LOAD_TEST_CLEANUP and BACKUP_SNAPSHOT — same
  // "heavy SDK density per job" profile, same posture. Bulk-delete UIs
  // serialize the enqueue side as belt + suspenders. SOC 2 CC7.4 —
  // subprocessor pressure bounded by config, provable from this file alone.
  CONCURRENCY_PROJECT_CASCADE: intEnv('WORKER_CONCURRENCY_PROJECT_CASCADE', 1),
  // Export-project (2026-05-15): user-triggered export jobs. I/O bound
  // (SDK pagination + S3 upload), not CPU bound. 4 concurrent = comfortable
  // throughput for the 100-150 user target without saturating the per-app
  // SDK rate limit. Each job reads up to 2 entity types (segments +
  // translations) at 2000 rows/page — bounded.
  CONCURRENCY_EXPORT_PROJECT: intEnv('WORKER_CONCURRENCY_EXPORT_PROJECT', 4),
  // Backup-snapshot (2026-05-15): admin/scheduled full-DB export. Reads
  // EVERY entity. Held at 1 — only one backup runs at a time, and the
  // job's SDK density is the highest of any worker (paginates ~30 entity
  // types in sequence). Running two simultaneously would saturate the
  // platform rate limit.
  CONCURRENCY_BACKUP_SNAPSHOT: intEnv('WORKER_CONCURRENCY_BACKUP_SNAPSHOT', 1),
  // Load-test fan-out (2026-05-18). Each in-flight fan-out is one job per
  // LoadTestRun; the actual fan-out work happens via tick-bounded calls
  // back into Base44, so the worker slot itself is mostly idle while a
  // tick is in flight. Concurrency=2 covers the rare case of two admin
  // load tests running back-to-back without queuing them.
  CONCURRENCY_LOAD_TEST_FANOUT: intEnv('WORKER_CONCURRENCY_LOAD_TEST_FANOUT', 2),
  // Load-test cleanup (B8, 2026-05-21). Held at 1 — only one cleanup per
  // fixture at a time, bottleneck is the Base44 per-app write rate limiter
  // (not parallelism). Bumping this would amplify 429 backoff without
  // shortening any single run. See processor file header for rationale.
  CONCURRENCY_LOAD_TEST_CLEANUP: intEnv('WORKER_CONCURRENCY_LOAD_TEST_CLEANUP', 1),
  // Load-test reseed (2026-05-22). Held at 1 for the same reason as
  // cleanup — only one reseed per fixture at a time, bottleneck is the
  // Base44 per-app write rate limiter. The reseed is just a delete-then-
  // create variant of cleanup; same rate-limiter wall, same posture.
  CONCURRENCY_LOAD_TEST_RESEED: intEnv('WORKER_CONCURRENCY_LOAD_TEST_RESEED', 1),
  // CC cue supersede (2026-05-28). Each in-flight job is one tick-resumable
  // bulk-supersede pass against ONE CCFormatRun. The supersede itself is
  // fast (bulkUpdate of 500 rows per call), and the engine dispatch tail
  // is a single HTTP POST — so the worker slot is mostly idle between
  // ticks. Concurrency=4 matches CC_FORMAT_RUN and gives 100-concurrent-
  // user re-transcribe headroom. Bottleneck is the per-tick Base44 write
  // budget, not parallelism — bumping higher would amplify 429 pressure
  // without shortening any single run.
  CONCURRENCY_CC_CUE_SUPERSEDE: intEnv('WORKER_CONCURRENCY_CC_CUE_SUPERSEDE', 4),

  ENQUEUE_PORT: intEnv('WORKER_ENQUEUE_PORT', 3000),
  ENQUEUE_SECRET: process.env.WORKER_ENQUEUE_SECRET || '',
};
