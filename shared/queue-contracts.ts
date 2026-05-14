// =============================================================================
// QUEUE CONTRACTS — Single source of truth for queue names and job payloads.
// -----------------------------------------------------------------------------
// Imported by BOTH:
//   - The worker (src/processors/*) — to type-check the job data it receives.
//   - Base44 functions that push jobs — to type-check the data they send.
//
// Adding a new queue: append here, add a processor file, register in index.ts.
// Changing a payload shape: bump JOB_SCHEMA_VERSION and migrate in-flight jobs.
// =============================================================================

export const JOB_SCHEMA_VERSION = 2;

export const QUEUE_NAMES = {
  VOICE_GEN: 'voice-gen',
  // (Legacy BATCH_TRANSLATE queue removed 2026-05-09 — translation now uses
  // the v4 producer/orchestrator/chunk pipeline below. The old runTranslation
  // function and batch-translate.ts processor were deleted.)
  // Legacy single-shot enrichment queue. Retained for backwards compat with
  // any in-flight v1 jobs; new producers should target the orchestrator/chunk
  // queues below instead.
  BATCH_ENRICH: 'batch-enrich',
  // v2 enrichment pipeline — producer/orchestrator/chunk model.
  ENRICH_ORCHESTRATOR: 'enrich-orchestrator',
  ENRICH_CHUNK: 'enrich-chunk',
  // v2 translation pipeline — producer/orchestrator/chunk model.
  // Same shape as enrichment: producer freezes a chunk_plan, orchestrator
  // dispatches chunks in bounded ticks, chunk worker calls a single provider
  // batch and writes records. Idempotent via completed_chunk_keys.
  TRANSLATE_ORCHESTRATOR: 'translate-orchestrator',
  TRANSLATE_CHUNK: 'translate-chunk',
  // v2 adaptation pipeline — producer/orchestrator/chunk model.
  // Single AdaptationRun entity carries a `kind` discriminator
  // (base_translation / retranslate_all / generate_adaptation). Same
  // hardening as translation: idempotent chunk skip, authoritative
  // chunk_completed finalize gate, atomic-ish counter commits.
  ADAPT_ORCHESTRATOR: 'adapt-orchestrator',
  ADAPT_CHUNK: 'adapt-chunk',
  // v2 AI rewrite pipeline (BULK shorten/expand from the Tools panel).
  // Single AIRewriteRun entity carries a `kind` discriminator
  // ('translation_bulk_shorten' | 'translation_bulk_expand'). Single-line
  // shorten/expand from the editor row stays SYNCHRONOUS (no queue) —
  // those are sub-cent ops with their own audit emission. The bulk
  // pipeline is for the Tools-panel CPS-band scanner that may rewrite
  // hundreds of lines in one run; cost-capped per project.
  AIREWRITE_ORCHESTRATOR: 'airewrite-orchestrator',
  AIREWRITE_CHUNK: 'airewrite-chunk',
  SRT_IMPORT: 'srt-import',
  // v2 HLS-to-MP4 ingest pipeline. Single-shot job (no chunks) but uses the
  // same scoped-JWT + checkpoint-resumable pattern as the other 4 heavy
  // pipelines. The worker steps a phase machine via `hlsIngestWorkerStep`:
  //   queued → codecs_validated → railway_dispatched → project_patched
  // The 'call_railway' phase is the long one (up to 15 min for a 90-min
  // source). We make that HTTP call directly from the worker (Node has no
  // 50s edge timeout) and re-call hlsIngestWorkerStep with `carry` so
  // Base44 finalizes the run.
  HLS_INGEST: 'hls-ingest',
  // CC Creation rules-engine re-apply pipeline. Single-shot job (no chunks).
  // Operator-triggered "Re-apply Spec" runs (operator_reapply / spec_change /
  // bulk_tool / import_normalize) go through this queue so the heavy
  // delete + bulkCreate of N CaptionCue rows lives in the worker's 30-min
  // budget instead of Base44's 3-min function ceiling. The initial format
  // produced by ccRunTranscription stays inline (it's already inside a job
  // with its own budget). ISOLATED to the CC Creation module.
  CC_FORMAT_RUN: 'cc-format-run',
  // v2 proxy-generation pipeline (2026-05-14). Replaces the legacy fire-and-
  // forget /generate-proxy + proxyGenerationCallback callback dance with
  // the same synchronous worker pattern HLS ingest uses. Single-shot job:
  // worker holds Railway connection open for up to 4hr (matches the
  // ffmpeg ceiling), 15s heartbeat to Redis, then calls proxyGenWorkerStep
  // to finalize the Project entity. Concurrency held at 1 — ffmpeg is
  // CPU-bound on the Railway dyno and serializing reduces blast radius.
  // Retry policy: attempts=2 (expensive job; transient retry costs 5-15min
  // of Railway compute) with 30s exponential backoff. Deterministic ffmpeg
  // failures throw UnrecoverableError to skip retry and go straight to DLQ.
  PROXY_GEN: 'proxy-gen',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

// ─── Payload shapes ───────────────────────────────────────────────────

export interface VoiceGenJobData {
  schema_version: number;
  project_id: string;
  segment_id: string;
  target_language: string;
  voice_id: string;
  voice_settings?: Record<string, unknown>;
  voice_mode?: 'synthesis' | 'cloning' | 'modeling';
  is_cloned?: boolean;
  previous_text?: string | null;
  next_text?: string | null;
  segment_duration_ms?: number;
  performance_prompt?: string | null;
  cue_stability?: number | null;
  user_email: string;
  request_id: string;
  auth_token?: string;
  priority_hint?: 'low' | 'normal' | 'high';
  /**
   * Parent JobRun id. generateOneSegment uses this to "tick" completion at the
   * end of every job — when all segments in the run reach a terminal state,
   * the JobRun is atomically marked completed/partial/failed. Closes the
   * SOC 2 CC7.2 zombie-JobRun gap. Optional for legacy/direct callers.
   */
  job_run_id?: string;
}

// Legacy v1 payload — still accepted by the batch-enrich queue.
export interface BatchEnrichJobData {
  schema_version: number;
  project_id: string;
  record_ids: string[];
  tier: 'draft' | 'standard' | 'master';
  enrichment_run_id: string;
  user_email: string;
  request_id: string;
}

// ─── v2 enrichment payloads ──────────────────────────────────────────
//
// The v2 pipeline splits enrichment into three roles:
//
//   Producer (Base44 fn `enqueueEnrichSuperscript`)
//     → Validates auth + ownership.
//     → Builds the frozen scene_plan and creates the SuperscriptEnrichmentRun.
//     → Mints a scoped JWT and enqueues ONE EnrichOrchestratorJobData job.
//
//   Orchestrator (worker → Base44 fn `orchestrateEnrichmentRun`)
//     → Runs ≤50s per tick. Reads run.checkpoint, advances scene_cursor by a
//       small batch, enqueues N EnrichChunkJobData jobs for that batch.
//     → If more scenes remain, re-enqueues itself with a small delay.
//     → If all scenes dispatched AND chunk_in_flight === 0, finalizes the run.
//
//   Chunk (worker → Base44 fn `enrichChunk`)
//     → Runs ≤50s per chunk. Processes ONE scene-chunk (≤20 records) end-to-
//       end: enrichment LLM call, verification, canon check, annotation writes.
//     → Idempotent via the per-annotation idempotency_key + a chunk-level
//       completed_chunk_keys guard on the run document.
//     → Decrements chunk_in_flight + increments chunk_completed when done.
//
// Each job carries a scoped JWT bound to the function it calls back. Worker
// forwards verbatim as X-Worker-JWT.

export interface EnrichOrchestratorJobData {
  schema_version: number;
  project_id: string;
  enrichment_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, run_id, 'orchestrateEnrichmentRun'). 30 min TTL. */
  auth_token?: string;
}

export interface EnrichChunkJobData {
  schema_version: number;
  project_id: string;
  enrichment_run_id: string;
  /** Stable id for this chunk: `${scene_id}:${chunk_index}`. Used for idempotency. */
  chunk_key: string;
  scene_id: string;
  chunk_index: number;
  /** The record IDs to process in this chunk. ≤20 per chunk. */
  record_ids: string[];
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, chunk_key, 'enrichChunk'). 30 min TTL. */
  auth_token?: string;
}

// ─── v2 translation payloads ─────────────────────────────────────────
//
// Mirrors the v2 enrichment pipeline. Each job carries a scoped JWT bound to
// the function it calls back. Worker forwards verbatim as X-Worker-JWT.
//
//   Producer (Base44 fn `enqueueTranslation`)
//     → Validates auth + ownership.
//     → Deletes any existing TranslationSegments for this language (replace
//       semantics — matches legacy runTranslation behaviour).
//     → Builds the frozen chunk_plan and creates the TranslationRun.
//     → Mints a scoped JWT and enqueues ONE TranslateOrchestratorJobData job.
//
//   Orchestrator (worker → Base44 fn `orchestrateTranslationRun`)
//     → Bounded ≤45s per tick. Reads run.checkpoint, advances chunk_cursor
//       by a small batch, enqueues N TranslateChunkJobData jobs.
//     → Re-enqueues itself with a small delay until all chunks dispatched.
//     → Finalizes run when chunk_completed >= chunk_total.
//
//   Chunk (worker → Base44 fn `translateChunk`)
//     → Bounded ≤50s per chunk. Translates ≤50 (DeepL/variant) or ≤20 (LLM)
//       segments via a single provider call, writes TranslationSegment rows
//       in bulk, commits counters atomically.
//     → Idempotent via completed_chunk_keys on the run document.

export interface TranslateOrchestratorJobData {
  schema_version: number;
  project_id: string;
  translation_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, run_id, 'orchestrateTranslationRun'). 30 min TTL. */
  auth_token?: string;
}

export interface TranslateChunkJobData {
  schema_version: number;
  project_id: string;
  translation_run_id: string;
  /** Stable id for this chunk: `chunk:${index}`. Used for idempotency. */
  chunk_key: string;
  chunk_index: number;
  /**
   * INLINE segments. The orchestrator resolves source text and embeds it
   * here so the chunk worker reads ZERO Base44 entities at execution time.
   * v4-rev2 (2026-05-09): combined with run params being inlined below,
   * the chunk function makes zero Base44 SDK calls. The orchestrator is
   * the SOLE writer for TranslationRun / TranslationSegment / CostLog.
   */
  segments: Array<{ source_segment_id: string; source_text: string }>;
  /** Inlined run params — chunk does not need to read TranslationRun. */
  provider: 'deepl' | 'gemini' | 'chatgpt' | 'claude' | 'variant';
  source_language_code: string;
  target_language_code: string;
  target_language_label: string;
  formality: string;
  context: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, chunk_key, 'translateChunk'). 30 min TTL. */
  auth_token?: string;
}

/**
 * v4-rev2 chunk return value. The orchestrator harvests these via
 * /job-status on each tick, then bulk-creates TranslationSegment rows
 * and updates TranslationRun counters in a single atomic write.
 *
 * ok=true  → translations carry the per-segment output. orchestrator
 *            bulkCreates and increments counters.
 * ok=false → terminal_error explains why; no retry will help. orchestrator
 *            records the failure and advances.
 *
 * Transient errors (network, 5xx, rate-limit) are NOT represented here —
 * they cause the chunk to throw, BullMQ retries up to 3×, and only after
 * exhaustion does the job land in state='failed' with failedReason.
 */
export interface TranslateChunkResult {
  ok: boolean;
  chunk_key: string;
  chunk_index: number;
  translations: Array<{ source_segment_id: string; translated_text: string }>;
  processed_count: number;
  translated_count: number;
  failed_count: number;
  characters_processed: number;
  cost_usd: number;
  prompt_version?: string;
  duration_ms: number;
  request_id: string;
  terminal_error: { code: string; message: string } | null;
}

export interface SrtImportJobData {
  schema_version: number;
  project_id: string;
  s3_key: string;
  user_email: string;
  request_id: string;
}

// ─── v2 HLS ingest payload ───────────────────────────────────────────
// Single-shot job — the worker walks the phase machine itself by calling
// hlsIngestWorkerStep repeatedly, NOT by re-enqueueing.
//
//   Producer (Base44 fn `enqueueHlsIngest`)
//     → Validates auth + ownership + concurrent-run guard.
//     → Creates HlsIngestRun (status=queued, drm_verdict=clean).
//     → Mints a 30-min scoped JWT bound to (user, project, run_id, fn).
//     → Enqueues ONE HlsIngestJobData job to the hls-ingest queue.
//
//   Worker (this processor)
//     → Loops: POST hlsIngestWorkerStep, follow `action` directive
//       (call_railway → POST Railway → recall function with carry,
//        recall_function → POST again, done → exit).
//     → Forwards the JWT verbatim as X-Worker-JWT on every Base44 call.
//     → On Railway dispatch, sends the api_key from the function response
//       (NOT from worker env — single source of truth lives on Base44).
//     → Heartbeats job lock during the long Railway call.

export interface HlsIngestJobData {
  schema_version: number;
  project_id: string;
  hls_ingest_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, run_id, 'hlsIngestWorkerStep'). 30 min TTL. */
  auth_token?: string;
}

// ─── CC format-run payload ────────────────────────────────────────────
//
// Single-shot job. The worker calls ccFormatRunWorkerStep ONCE; that
// function runs the rules engine end-to-end (load cues → engine → delete +
// bulkCreate → finalize CCFormatRun + Project) inside its function budget,
// updating CCFormatRun.progress_pct / current_phase as it goes. The worker
// just heartbeats during the call and exits when the function returns
// action='done'. Pattern mirrors hls-ingest exactly — same JWT model,
// same heartbeat shape, same DLQ semantics.

export interface CCFormatRunJobData {
  schema_version: number;
  project_id: string;
  format_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, format_run_id, 'ccFormatRunWorkerStep'). 30 min TTL. */
  auth_token?: string;
}

// ─── v2 proxy-generation payload (2026-05-14) ────────────────────────
//
// Single-shot job. Replaces the legacy fire-and-forget /generate-proxy +
// webhook-callback dance with the same synchronous pattern HLS ingest
// uses. Pipeline:
//
//   Producer (Base44 fn `generateProxy`)
//     → Validates auth + ownership.
//     → Resolves StorageProfile + signs the source S3 URL (6h TTL).
//     → Mints the proxy_video_key + proxy_audio_key in the project namespace.
//     → Flips Project.proxy_status = 'generating', clears proxy_error.
//     → Mints a 60-min scoped JWT bound to (user, project, project_id,
//       'proxyGenWorkerStep').
//     → Enqueues ONE ProxyGenJobData job to the proxy-gen queue.
//     → Returns immediately so the editor card shows "Optimizing for editor…"
//
//   Worker (src/processors/proxy-gen.ts)
//     → POSTs to Railway /generate-proxy-sync (synchronous endpoint — Railway
//       runs ffmpeg, uploads both S3 objects, returns 200 with the keys).
//     → Connection held open up to 4hr (matches ffmpeg ceiling).
//     → 15s heartbeat extends BullMQ job lock during the long call.
//     → On Railway success → POSTs proxyGenWorkerStep with the result so the
//       Project entity is finalized with proxy_status='ready' + keys.
//     → On Railway failure → throws → BullMQ retries per queue policy →
//       after 2 attempts the job lands in the DLQ and proxyGenWorkerStep
//       is called with action='fail' so the Project shows proxy_status='failed'.
//
// SECURITY MODEL — identical to HLS ingest:
//   • Scoped JWT (60-min TTL) verified by proxyGenWorkerStep on every call.
//   • Railway api_key forwarded from the producer via job.data so the single
//     source of truth lives on Base44 (no Railway-key in worker env).
//   • The signed source URL has its own 6h S3 TTL — even if exfiltrated, the
//     attacker only gets read access to ONE source media file for ≤6h.
//
// AUDIT POSTURE (SOC 2 CC7.2 / TPN MS-7.x):
//   • Project.proxy_status is the audit row — auditor can answer "what is
//     the proxy state of project X?" from a single field.
//   • BullMQ retains failed jobs for 7 days (DEFAULT_JOB_OPTIONS) so the DLQ
//     panel shows every failed proxy attempt with attemptsMade + failedReason.
//   • StructuredLog rows are emitted on every state transition (enqueued,
//     railway_dispatched, completed, failed) — full forensic trail.

export interface ProxyGenJobData {
  schema_version: number;
  project_id: string;
  user_email: string;
  request_id: string;
  /** Signed S3 GET URL Railway uses to read the source media. 6h TTL. */
  source_url: string;
  /** Project's pinned S3 bucket — Railway writes the two proxy objects here. */
  bucket: string;
  /** Project's pinned AWS region. */
  region: string;
  /** Output key for the 720p H.264 video proxy. */
  proxy_video_key: string;
  /** Output key for the 16 kHz mono FLAC audio proxy. */
  proxy_audio_key: string;
  /**
   * Optional credential prefix for multi-region storage (e.g. 'STORAGE_EU_CENTRAL').
   * Railway reads {prefix}_ACCESS_KEY_ID / {prefix}_SECRET_ACCESS_KEY when
   * present; falls back to AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY otherwise.
   */
  credential_secret_prefix?: string;
  /**
   * Railway api_key forwarded from the producer. Single source of truth lives
   * on Base44; worker does NOT hold this in env. Mirrors HLS-ingest design.
   */
  railway_api_key: string;
  /**
   * Railway base URL (no trailing slash, no path). Producer reads this from
   * a Base44 secret and forwards it so the URL/key pair travels together.
   */
  railway_url: string;
  /** Scoped JWT bound to (user, project, project_id, 'proxyGenWorkerStep'). 60 min TTL. */
  auth_token?: string;
}

// ─── v2 adaptation payloads ──────────────────────────────────────────
//
// Mirrors the v2 translation pipeline. One AdaptationRun discriminated by
// `kind` ('base_translation' | 'retranslate_all' | 'generate_adaptation')
// — same producer/orchestrator/chunk shape and same idempotency model.

export interface AdaptOrchestratorJobData {
  schema_version: number;
  project_id: string;
  adaptation_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, run_id, 'orchestrateAdaptationRun'). */
  auth_token?: string;
}

export interface AdaptChunkJobData {
  schema_version: number;
  project_id: string;
  adaptation_run_id: string;
  /** Stable id for this chunk: `chunk:${index}`. Used for idempotency. */
  chunk_key: string;
  chunk_index: number;
  /** TranscriptSegment IDs (kind='base_translation'). */
  source_segment_ids: string[];
  /** AdaptationSegment IDs (kind='retranslate_all' or 'generate_adaptation'). */
  adaptation_segment_ids: string[];
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, chunk_key, 'adaptChunk'). */
  auth_token?: string;
}

// ─── v2 AI rewrite payloads (bulk shorten/expand) ────────────────────
//
//   Producer (Base44 fn `enqueueAIRewriteRun`)
//     → Validates auth + ownership.
//     → Scans the project for rewrite candidates by mode (shorten/expand)
//       using BOTH a CPS gate and (when audio exists) a fit-compression gate,
//       both tunable from the UI.
//     → Performs a PRE-FLIGHT cost estimate against Project.cost_cap_per_rewrite_usd.
//       If estimated cost > cap → refuses to start (returns 409).
//     → Freezes a chunk_plan (≤10 translation_ids per chunk) and creates the
//       AIRewriteRun with cost_cap_usd pinned.
//     → Mints a scoped JWT and enqueues ONE AIRewriteOrchestratorJobData job.
//
//   Orchestrator (worker → Base44 fn `orchestrateAIRewriteRun`)
//     → ≤45s per tick. Reads run.checkpoint, advances chunk_cursor, dispatches
//       N AIRewriteChunkJobData jobs. Soft-stops dispatch when cumulative
//       cost_usd ≥ cost_cap_usd: marks cost_cap_breached=true and stops
//       dispatching new chunks, but lets in-flight chunks DRAIN before
//       finalising as 'partial' on a later tick. This matches the M2 spec
//       (auditor evidence: cap is a planning constraint AND a circuit-breaker,
//       in-flight work isn't lost).
//     → Re-enqueues itself with a small delay until all chunks dispatched.
//     → Finalises run when chunks_terminal >= chunk_total.
//
//   Chunk (worker → Base44 fn `rewriteChunk`)
//     → ≤50s per chunk. Rewrites N translations (one LLM call per line — these
//       are CPS-verified per-line rewrites, not batchable like translation).
//     → Concurrency-bounded by the worker concurrency knob; lines run serially
//       inside the chunk to keep the per-line audit trail strict.
//     → Each line writes its before/after to the chunk's accumulator; the
//       chunk-level commit appends counters atomically.

export interface AIRewriteOrchestratorJobData {
  schema_version: number;
  project_id: string;
  rewrite_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, run_id, 'orchestrateAIRewriteRun'). */
  auth_token?: string;

  // ─── v3 INLINED PAYLOAD (2026-05-09) ──────────────────────────────────
  // The orchestrator does NOT read AIRewriteRun from inside backend-function
  // context — that read path is broken on this entity (see incident
  // 2026-05-09: base44.asServiceRole.entities.AIRewriteRun.[get|filter]
  // returns empty for verifiably-present rows). Instead, the producer
  // inlines all immutable run config into the job payload at enqueue
  // time, and mutable run state is passed forward across ticks via
  // next-tick payload (snapshot fields below). Writes to AIRewriteRun
  // still happen via .update() for audit/UI — only reads are eliminated.
  // Mirrors the same pattern translateChunk uses (schema_version: 3).

  /** Immutable run config — frozen at producer time. */
  inlined_plan?: {
    kind: 'translation_bulk_shorten' | 'translation_bulk_expand';
    chunk_plan: Array<{ chunk_index: number; translation_ids: string[] }>;
    chunk_total: number;
    cost_cap_usd: number | null;
    started_at: string;
  };
  /** Mutable run state — carried forward each tick. Empty on first tick. */
  state?: {
    chunk_cursor: number;
    completed_chunk_keys: string[];
    chunk_failures: Array<{ chunk_index: number; attempts: number; error: string; record_count?: number }>;
    chunk_jobs: Record<string, string>; // chunk_key -> bullmq_job_id
    cost_usd: number;
    processed_count: number;
    succeeded_count: number;
    failed_count: number;
    characters_processed: number;
    cost_cap_breached: boolean;
    tick_count: number;
    status: 'queued' | 'orchestrating' | 'running';
  };
}

export interface AIRewriteChunkJobData {
  schema_version: number;
  project_id: string;
  rewrite_run_id: string;
  /** Stable id for this chunk: `chunk:${index}`. Used for idempotency. */
  chunk_key: string;
  chunk_index: number;
  /** TranslationSegment IDs to rewrite in this chunk. ≤10 per chunk. */
  translation_ids: string[];
  /** Mirror of the run's mode for fast dispatch. 'shorten' | 'expand'. */
  mode: 'shorten' | 'expand';
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, chunk_key, 'rewriteChunk'). */
  auth_token?: string;
  // ─── v3 INLINED RUN CONFIG (2026-05-09) ───────────────────────────────
  // The chunk function CANNOT read AIRewriteRun (platform read bug — see
  // AIRewriteOrchestratorJobData rationale). Producer inlines all run
  // config the chunk needs at orchestrator-dispatch time.
  inlined_run_config?: {
    provider: 'gemini' | 'chatgpt';
    model: string;
    target_language_code: string;
    notes: string;
    user_overrides: Record<string, unknown>;
  };
}

/**
 * v3 chunk return value. The orchestrator harvests these from BullMQ via
 * /job-status on each tick (same pattern as TranslateChunkResult). The
 * orchestrator is the SOLE writer for AIRewriteRun counters; the chunk
 * only writes to TranslationSegment (the actual rewritten text) and
 * returns its accounting via this shape.
 */
export interface AIRewriteChunkResult {
  ok: boolean;
  chunk_key: string;
  chunk_index: number;
  /** Per-line outcomes for orchestrator's audit aggregation. */
  processed_count: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
  characters_processed: number;
  cost_usd: number;
  /** When ok=false, why this chunk should be marked failed. */
  terminal_error: { code: string; message: string } | null;
  /** Per-line failure detail to bubble up into AIRewriteRun.chunk_failures. */
  failed_record_ids: string[];
  duration_ms: number;
  request_id: string;
}

// Discriminated union for processors that need to handle multiple shapes.
export type AnyJobData =
  | VoiceGenJobData
  | BatchEnrichJobData
  | EnrichOrchestratorJobData
  | EnrichChunkJobData
  | TranslateOrchestratorJobData
  | TranslateChunkJobData
  | AdaptOrchestratorJobData
  | AdaptChunkJobData
  | AIRewriteOrchestratorJobData
  | AIRewriteChunkJobData
  | SrtImportJobData
  | HlsIngestJobData
  | CCFormatRunJobData
  | ProxyGenJobData;

// ─── Default per-queue options (used by both producer and consumer) ──

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 }, // 5s, 25s, 125s
  removeOnComplete: { age: 3600, count: 1000 },           // 1h or last 1000
  removeOnFail: { age: 86400 * 7 },                        // keep failed 7d
};

// Orchestrator should retry less aggressively — a stuck run needs human eyes,
// not infinite re-ticks. 2 attempts means 1 retry then DLQ.
export const ORCHESTRATOR_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 10000 },
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 86400 * 7 },
};

// Proxy-gen: even more conservative than orchestrator. Each retry costs
// 5-15 min of Railway compute, so we want at most ONE retry before DLQ.
// Deterministic ffmpeg failures (non-zero exit code, missing source) throw
// UnrecoverableError in the processor to skip retry entirely.
//
// Retry policy auditor framing (SOC 2 CC7.4 — Subprocessor / Vendor Failure
// Response): bounded retry on transient failures (network blips, Railway
// pod restarts), immediate DLQ on deterministic failures. Every retry +
// every DLQ entry is auditable via BullMQ failedReason + the StructuredLog
// rows the processor emits.
export const PROXY_GEN_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 30000 }, // 30s then DLQ
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86400 * 7 },                         // keep failed 7d for DLQ
};
