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
  | HlsIngestJobData;

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
