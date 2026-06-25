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

export const JOB_SCHEMA_VERSION = 3;

export const QUEUE_NAMES = {
  VOICE_GEN: 'voice-gen',
  // v2 voice-gen producer/orchestrator/tick pipeline (2026-05-18). The
  // legacy runVoiceGeneration function fanned out 5000+ enqueue calls
  // synchronously inside the 180s function ceiling — at 100+ user
  // concurrency this would timeout on long-form content. The new
  // producer (runVoiceGeneration) creates the JobRun + freezes a
  // chunk_plan, then enqueues ONE orchestrator job. The orchestrator
  // ticks bounded batches (~150 voice-gen jobs per 45s tick) and re-
  // enqueues itself until all segments dispatched. The voice-gen
  // workers themselves are unchanged — still one job per segment.
  // Auditor framing (SOC 2 CC7.2): the fan-out is now resumable.
  VOICE_GEN_ORCHESTRATOR: 'voice-gen-orchestrator',
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
  // Project cascade-delete pipeline (2026-05-15). Single-shot job that
  // deletes all S3 objects + all project-scoped DB rows + the Project row.
  PROJECT_CASCADE: 'project-cascade',
  // User-triggered export pipeline (2026-05-15). Single-shot job per export
  // request. The worker paginates segments/translations/cues, builds the
  // output content (SRT/VTT/CSV/JSON/TXT), uploads to S3 under
  // dubflow/exports/<project_id>/<job_id>/<filename>, and calls
  // exportProjectWorkerStep to finalize the ExportJob entity with the
  // signed URL. ONE queue serves all four editor modules — the job carries
  // a `kind` discriminator ('dub' | 'superscript' | 'adaptation' | 'cc').
  // Concurrency held at 4 — exports are I/O bound (SDK pagination), not
  // CPU bound, so we can run several in parallel without saturating.
  EXPORT_PROJECT: 'export-project',
  // Weekly backup-snapshot pipeline (2026-05-15). Single-shot job. The
  // worker paginates EVERY entity into a single JSON file under
  // dubflow/backups/YYYY-MM-DD/full-backup.json, then prunes old backups
  // to KEEP_LAST_N. Concurrency=1 (only one backup runs at a time).
  BACKUP_SNAPSHOT: 'backup-snapshot',
  // Admin-only load-test harness fan-out pipeline (2026-05-18). Mirrors the
  // voice-gen / translate / airewrite orchestrator pattern: ONE job per
  // LoadTestRun, tick-driven, resumable. Each tick calls Base44's
  // loadTestFanoutWorkerStep with the inlined plan + current state; the
  // step fires a bounded batch of producer calls (e.g. enqueueTranslation
  // x≤8) inside its own 30s budget, persists progress to
  // LoadTestRun.metrics._driver, and returns next_state. The worker
  // re-enqueues until dispatch_cursor === concurrency_target.
  //
  // Architectural purpose: keep the LOAD-TEST HARNESS in a runtime that is
  // not subject to Base44's per-function HTTP ceiling so measurements of
  // the Base44 system-under-test (gateway, DB writes, orchestrator) are
  // not contaminated by harness limitations.
  LOAD_TEST_FANOUT: 'load-test-fanout',
  // Worker-side bulk cleanup for load-test fixtures (B8, 2026-05-21).
  // ONE job per LoadTestCleanupRun. Each tick calls back into
  // loadTestCleanupWorkerStep on Base44, which deletes one bounded page
  // (≤200 rows) of one entity bucket within its 22s budget and returns
  // next_tick. The worker re-enqueues until current_phase === 'done'.
  // Hard-pinned to the four __loadtest_* fixture project names; refuses
  // anything else (enforced in both the producer AND every worker tick).
  //
  // Architectural purpose: Base44's 30s function ceiling can't drain a
  // 5k-row dirty fixture in a single call. This queue inherits the
  // worker's 1hr job ceiling so cleanup runs to completion regardless
  // of fixture size — eliminates the 504 timeout failure mode that
  // motivated B8.
  LOAD_TEST_CLEANUP: 'load-test-cleanup',
  // Worker-side deterministic TranslationSegment reseed for load-test
  // fixtures (2026-05-22). Replaces the in-platform _loadTestSeedTranslations
  // function which 502'd on any dirty fixture because the synchronous
  // delete loop saturated the platform write rate limiter inside Base44's
  // 30s function ceiling. ONE job per LoadTestReseedRun. Each tick calls
  // back into loadTestReseedWorkerStep on Base44, which advances one
  // language's wipe + deterministic seed under its own 22s budget and
  // returns next_tick. The worker re-enqueues until
  // current_language_index === languages.length. Hard-pinned to the four
  // __loadtest_* fixture project names; refuses anything else (enforced
  // in both the producer AND every worker tick). Only mutates
  // TranslationSegment — never touches Project / TranscriptSegment /
  // Speaker / TranslationRun / AIRewriteRun rows. SOC 2 CC8.1.
  LOAD_TEST_RESEED: 'load-test-reseed',
  // CC Creation cue supersede + engine dispatch pipeline (2026-05-28).
  // -------------------------------------------------------------------
  // Replaces the in-band supersede + Railway POST that previously ran
  // inside ccRunTranscription. On a >800-cue project the synchronous
  // supersede loop exceeded Base44's 30s function ceiling, leaving
  // CCFormatRun + JobRun in 'running' forever and the editor overlay
  // permanently stuck on "Dispatching 0%" (incident 2026-05-28).
  //
  // This queue is single-shot per CCFormatRun. The worker step is
  // resumable — each tick paginates up to ~500 active CaptionCue rows,
  // flips is_active=true → false via bulkUpdate with 429-aware retries,
  // updates CCFormatRun.cue_supersede_progress, and returns one of:
  //   • action='continue' → worker re-enqueues itself for the next page
  //   • action='dispatch_engine' → all cues superseded; worker calls
  //     ccDispatchToEngine which POSTs to Railway and pins engine_job_id
  //   • action='done' → no engine dispatch needed (admin_cleanup /
  //     speaker_rename) — terminal success
  //
  // Concurrency held at 4 — matches CC_FORMAT_RUN and other heavy
  // single-shot pipelines. Supports 100+ concurrent users initiating
  // re-transcribe simultaneously (each run takes ~2-10s of supersede
  // wall-clock + ~5-15s engine dispatch, then hands off to AAI).
  //
  // SOC 2 CC8.1 — no caption row is silently destroyed; every superseded
  // row carries (superseded_by_run_id, superseded_at) joining back to
  // the CCFormatRun that obsoleted it.
  CC_CUE_SUPERSEDE: 'cc-cue-supersede',
  // AI-Dubbing transcript REPLACE pipeline (2026-06-09). Scoped EXCLUSIVELY to
  // mode='replace' — create/import into a brand-new empty project stays
  // synchronous (no existing transcript to protect, never caused the 504).
  // -------------------------------------------------------------------
  // Replaces the in-band destructive replace that previously ran inside
  // importTranscript. On a 400+ row TTML the synchronous path paginated +
  // deleted every TranscriptSegment / TranslationSegment / Speaker then
  // bulk-created the new segments in-band, blowing past the gateway timeout
  // and stranding the project mid-destruction (incident 2026-06-09).
  //
  // STAGE-THEN-FLIP (the explicit "old transcript stays visible until the
  // replacement is staged" requirement): this queue is single-shot per
  // TranscriptImportRun and the worker step is tick-resumable. Each tick:
  //   • Phase 'staging_new': bulk-create up to ~150 NEW TranscriptSegment
  //     rows as is_active=false (tagged import_run_id) while the OLD rows
  //     stay is_active=true and fully visible in the editor — there is
  //     never an empty-transcript window. Resumes from checkpoint.stage_cursor.
  //   • Phase 'cutover' (once all new rows staged): flip this run's new rows
  //     is_active=false→true AND supersede the old rows (TranscriptSegment +
  //     TranslationSegment + Speaker) is_active=true→false, stamping
  //     superseded_by_run_id + superseded_at. The editor's is_active read
  //     flips old→new with no observable gap.
  //   • Phase 'finalizing': update Project workflow/counters, write ActivityLog.
  //
  // The worker re-enqueues itself between phases/pages until the step returns
  // action='done'. watchdogTranscriptImportRuns recovers a stalled run.
  //
  // SOC 2 CC7.2 — resumable: a pod death mid-stage re-creates ZERO already-
  // staged rows (cursor + import_run_id make resume idempotent).
  // SOC 2 CC8.1 — every superseded transcript/translation row joins back to
  // the exact TranscriptImportRun that obsoleted it.
  TRANSCRIPT_IMPORT: 'transcript-import',
  // GLTV API cascade orchestrator (Phase 2, 2026-06-12). FULLY ISOLATED to the
  // GLTV API product surface — never shares state, queue, or concurrency lane
  // with any human Media Creator pipeline. ONE single-shot tick-resumable job
  // per DubbingApiJob. The worker calls gltvCascadeWorkerStep on each tick; the
  // step performs exactly ONE idempotent phase transition (start-or-poll keyed
  // by the job's *_run_id fields) and returns:
  //   • action='continue'   → more work in this phase; worker re-enqueues self
  //                            after GLTV_CASCADE_TICK_DELAY_MS (10s)
  //   • action='advance'    → phase complete, status advanced; re-enqueue next tick
  //   • action='await_review' → checkpoint-mode parked at awaiting_review;
  //                            worker exits (gltvApproveDubbingJob re-enqueues)
  //   • action='done'       → terminal (completed/failed/cancelled); worker exits
  //
  // Pattern mirrors cc-cue-supersede exactly (single-shot, tick-resumable,
  // heartbeat-extended lock, JWT-scoped callback). Concurrency is its OWN lane
  // (GLTV_CASCADE_CONCURRENCY, default 5) so an API burst can NEVER starve human
  // editors. Gated off until the gltv_cascade_enabled FeatureFlag is on.
  //
  // SOC 2 CC7.2 — resumable: a pod death mid-phase re-reads DubbingApiJob.status
  // + *_run_id and resumes the exact phase (no double-start). CC8.1 — every
  // phase transition appends to DubbingApiJob.phase_history with timestamps +
  // the underlying run id.
  GLTV_CASCADE: 'gltv-cascade',
  // Simple Translation (SRT) async translate pipeline (2026-06-16). FULLY
  // ISOLATED to the Translation module (project_type='simple_translation' +
  // TranslationCue + SimpleTranslationRun) — never shares state, queue, or
  // concurrency lane with the AI-Dubbing translate pipeline (TRANSLATE_*) or
  // any other surface. Single-shot tick-resumable job per SimpleTranslationRun.
  // The worker calls srtTranslateWorkerStep in a loop; each tick translates a
  // bounded batch (~120 cues) in parallel via the caller-chosen provider
  // (DeepL / Gemini / ChatGPT) and writes the results back inside its own ~22s
  // budget, returning action='continue' (re-call) or action='done' (finalize).
  //
  // WHY: the old translateSrtProject translated + delete+bulkCreate'd the whole
  // cue set in ONE function call — fine for short subtitle files, but a feature
  // film (1000-3000+ cues) under 100+ concurrent users brushed the function
  // gateway ceiling and concentrated the entire write burst into one budget.
  // The tick design spreads it across resumable batches so a full movie
  // translates reliably regardless of concurrency. A pod death mid-run re-reads
  // SimpleTranslationRun.checkpoint.cursor + only translates 'pending' cues, so
  // resume never re-translates a done cue (idempotent).
  //
  // Concurrency: its OWN lane (default 4) so a translation burst never starves
  // any other pipeline. SOC 2 CC7.2 — resumable; CC8.1 — provider + per-cue
  // provenance (TranslationCue.translated_by_provider) join back to the run.
  SRT_TRANSLATE: 'srt-translate',
  // M&E extraction harvester (2026-06-25). A PERPETUAL, self-rescheduling
  // heartbeat that drives every in-flight LALAL.AI M&E extraction to completion
  // independent of any browser tab. This is the PORTABILITY anchor for M&E: the
  // scheduler lives HERE (in the git-versioned worker repo, on Railway), NOT in
  // a Base44-platform scheduled automation — so M&E survives leaving Base44
  // exactly like every other pipeline. The worker re-enqueues its own next
  // sweep on a fixed delay (gltv-cascade self-reschedule pattern); the per-tick
  // step calls the Base44 fn `pollMEStatus` (single source of truth for the
  // LALAL /check → download stems → S3 → finalize-Project path, shared with the
  // editor's live poll, so there is ZERO finalize-logic drift). The only Base44
  // touch is the same data-layer write every processor already crosses via
  // base44-client. Producer `enqueueMEPoll` seeds the heartbeat once at deploy.
  // SOC 2 CC7.2 — resumable + browser-independent; CC8.1 — pollMEStatus owns
  // the audit/cost trail. Single perpetual job (deterministic jobId), so a
  // double-seed is a no-op.
  ME_POLL: 'me-poll',
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
  /**
   * Force overwrite. When true, generateOneSegment bypasses its idempotency
   * guard and re-renders the segment even if it already has ready audio.
   * Set by the producer (runVoiceGeneration) from the run-level force flag —
   * the operator explicitly asked to re-render (performance direction applied,
   * voice changed, manual regenerate). Without threading this through to the
   * per-segment job, an already-dubbed line is silently idempotent-skipped and
   * the old take is retained. Optional — omitted (false) for fresh dubs.
   * SOC 2 CC8.1 — an explicitly-requested re-render is never silently dropped.
   */
  force?: boolean;
  /**
   * Voice Consistency Engine strategy (Phase 3, 2026-05-25).
   * Optional — when omitted, generateOneSegment defaults to 'NONE' so existing
   * call sites stay bit-for-bit unchanged. Values: 'NONE' | 'REFERENCE_CONTEXT' |
   * 'SEED_LOCK' | 'STYLE_MATCH' | 'PROVIDER_NATIVE'.
   *
   * 'REFERENCE_CONTEXT' is the only value the editor surfaces today (via the
   * per-segment "Match surrounding voice" toggle + the project-level default).
   * The strategy resolver inside generateOneSegment gracefully degrades when
   * the (provider, model) pair can't satisfy the requested strategy — the
   * degraded result is recorded on the VoiceGenerationRun audit row.
   *
   * Bulk generation deliberately omits this field in Phase 3 (manual-only
   * scope per the spec); bulk runs continue using the existing default 'NONE'
   * posture for safety.
   *
   * SOC 2 CC8.1 — every requested strategy is provably attributable to the
   * single job that carried it. The audit row pins both requested AND applied,
   * so any divergence is forensically resolvable from the row alone.
   */
  consistency_strategy?: 'NONE' | 'REFERENCE_CONTEXT' | 'SEED_LOCK' | 'STYLE_MATCH' | 'PROVIDER_NATIVE';
}

// ─── v2 voice-gen orchestrator payload (2026-05-18) ──────────────────
//
// Producer (Base44 fn `runVoiceGeneration`)
//   → Validates auth + ownership + concurrent-run guard.
//   → Resolves all voice/speaker/style context once, freezes a chunk_plan
//     (each plan entry = a fully-built VoiceGenJobData payload, pinned).
//   → Creates JobRun with the frozen plan.
//   → Mints a scoped JWT and enqueues ONE VoiceGenOrchestratorJobData job.
//
// Orchestrator (worker → Base44 fn `orchestrateVoiceGenerationRun`)
//   → Bounded ≤45s per tick. Advances dispatch_cursor by VOICE_GEN_DISPATCH_PER_TICK.
//   → Mints a NEW per-segment JWT for each voice-gen job (so the 15-min TTL
//     starts when the segment is actually about to run, not at producer time).
//   → Re-enqueues itself until all segments dispatched.
//   → Once dispatch_cursor >= chunk_total, exits (the per-segment
//     generateOneSegment workers do their own work, frontend polls JobRun
//     for terminal status; the finalizer or watchdog closes the run).
//
// State carried forward across ticks via inlined_plan + state, same pattern
// as AIRewriteOrchestratorJobData (incident 2026-05-09 read-path workaround).

export interface VoiceGenOrchestratorJobData {
  schema_version: number;
  project_id: string;
  job_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, job_run_id, 'orchestrateVoiceGenerationRun'). 30 min TTL. */
  auth_token: string;
  /** Immutable run config — frozen at producer time. */
  inlined_plan: {
    target_language: string;
    /** Each entry is a fully-built voice-gen payload (minus auth_token, which
     *  the orchestrator mints per-segment on dispatch). */
    chunk_plan: Array<Omit<VoiceGenJobData, 'schema_version' | 'auth_token' | 'request_id'>>;
    chunk_total: number;
    started_at: string;
  };
  /** Mutable run state — carried forward each tick. Empty on first tick. */
  state: {
    dispatch_cursor: number;
    /** segment_id (translation_id) → bullmq job_id; bookkeeping for ops/DLQ. */
    dispatched_jobs: Record<string, string>;
    enqueue_failed_count: number;
    enqueue_failed_ids: string[];
    tick_count: number;
  };
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
    /**
     * chunk_key -> ISO timestamp the chunk was (re-)dispatched. Powers the
     * orchestrator's per-chunk staleness reclaim (2026-06-02): a chunk in
     * flight longer than the hard ceiling is treated as abandoned and
     * re-dispatched once, then terminalised. Without this, a chunk wedged
     * in BullMQ `active` (dead pod) strands the run forever under a live
     * orchestrator. Carried forward each tick. SOC 2 CC7.2.
     */
    chunk_dispatch_at?: Record<string, string>;
    /**
     * chunk_key -> count of stale-reclaim re-dispatches (cap 1). Bounds the
     * reclaim so a structurally-broken chunk terminalises rather than
     * re-dispatching forever. SOC 2 CC7.4.
     */
    stale_reclaim_tracker?: Record<string, number>;
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
  /**
   * v3 pure-compute contract (incident 2026-05-09): the chunk function makes
   * ZERO Base44 reads. The producer inlines every translation row the chunk
   * needs (source_segment_id, current translated_text, segment duration,
   * speaker label for prompt context). The orchestrator forwards this array
   * verbatim. The chunk LLM calls operate on this in-memory payload only;
   * the orchestrator is the SOLE writer for TranslationSegment when it
   * harvests this chunk's return value.
   */
  inlined_translations: Array<{
    translation_id: string;
    source_segment_id: string;
    translated_text: string;
    segment_duration_sec: number;
    speaker_label: string;
  }>;
  /** Mirror of the run's mode for fast dispatch. 'shorten' | 'expand'. */
  mode: 'shorten' | 'expand';
  /** Provider pinned by the producer at run-start. */
  provider: 'gemini' | 'chatgpt';
  /** Free-text project context threaded into the rewrite prompt. */
  project_context: string;
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
  /** Total worker-side wall-clock for this chunk invocation (JWT verify ->
   *  provider call(s) -> response build). The orchestrator aggregates this as
   *  the run-level worker_execution_ms summary. */
  duration_ms: number;
  /** PILOT TELEMETRY (2026-06-19, additive). Isolated time spent inside the LLM
   *  provider call loop (Gemini/OpenAI REST), in ms — measured by rewriteChunk
   *  around the rewriteBatch* call, distinct from total worker duration_ms.
   *  The orchestrator aggregates this as the run-level provider_latency_ms
   *  summary AND logs it per-chunk to the airewrite_chunk_timing StructuredLog
   *  stream. Isolating provider latency from worker overhead is what answers
   *  'is the provider the bottleneck, or our orchestration?'. */
  provider_latency_ms?: number;
  request_id: string;
}

// ─── v1 export-project payload (2026-05-15) ──────────────────────────
//
// Single-shot job per export request. Replaces the synchronous exportProject /
// exportSuperscriptProject / exportAdaptation / ccExportProject functions
// which all paginate large datasets in-band and would timeout at the 180s
// function ceiling on 5000+ line projects under concurrent load.
//
// Pipeline:
//   Producer (Base44 fn `enqueueExportProject` and module-specific aliases)
//     → Validates auth + ownership + format.
//     → Creates ExportJob (status='queued') for audit + status polling.
//     → Mints 30-min scoped JWT bound to (user, job_id, 'exportProjectWorkerStep').
//     → Enqueues ONE ExportJobData job to the export-project queue.
//
//   Worker (src/processors/export-project.ts)
//     → Dispatches by `kind`: paginates all entities for the requested module,
//       builds the output content (SRT/VTT/CSV/JSON/TXT) entirely in-memory,
//       uploads to S3 under dubflow/exports/<project_id>/<job_id>/<filename>.
//     → POSTs exportProjectWorkerStep with the S3 key + size + duration.
//
//   Finalizer (Base44 fn `exportProjectWorkerStep`)
//     → Signs the S3 URL (24h TTL), updates ExportJob with status='completed' +
//       file_url + file_size_bytes.
//     → Writes ActivityLog 'export.completed' for the audit trail.
//
// SECURITY MODEL — same as project-cascade:
//   • Scoped JWT (30-min TTL) verified by exportProjectWorkerStep.
//   • ExportJob.created_by gates who can poll/download.
//   • Signed URL has 24h TTL — sufficient for the user to download once.
//
// AUDIT POSTURE (SOC 2 CC8.1 / TPN MS-4.x — deliverable chain of custody):
//   • Every export is a tracked entity, not an ephemeral request/response.
//   • ActivityLog 'export.completed' captures actor + project + format +
//     target_language + signed URL byte size.
//   • BullMQ retains failed jobs for 7 days — every failed export is
//     queryable from the DLQ panel.

export interface ExportJobData {
  schema_version: number;
  /** Discriminator — selects which entity tree to paginate + which builders to use.
   *  'audio' is the AI-Dubbing audio/video deliverable path: instead of building
   *  text bytes from entity data, the worker calls Railway /mix-final directly
   *  (it has no function ceiling, only a heartbeat-extended BullMQ lock), streams
   *  the WAV to S3, and calls exportProjectWorkerStep to finalize. This is the
   *  Path-A move that takes the long /mix-final call off the browser/function
   *  gateway timeout that produced the infinite export spinner. */
  kind: 'dub' | 'superscript' | 'adaptation' | 'cc' | 'audio';
  export_job_id: string;
  project_id: string;
  user_email: string;
  request_id: string;
  /** Output format — interpreted by the module-specific builder. For kind='audio' always 'wav'. */
  format: string;
  /** Target language (when format is per-language: srt/vtt/txt_translation/csv, OR any audio export). */
  target_language_code?: string;
  /** Where to drop the output in S3. Producer mints the full key. For per_speaker
   *  audio this is the key PREFIX; the worker appends a per-speaker suffix. */
  s3_bucket: string;
  s3_key: string;
  s3_region: string;
  credential_secret_prefix?: string;
  /** Filename the UI should suggest on download. */
  suggested_filename: string;
  /** Optional CC export options (passed through verbatim to ccExporters). */
  cc_options?: Record<string, unknown>;
  /** Optional Superscript / Adaptation export options. */
  module_options?: Record<string, unknown>;
  /** [audio kind] Which deliverable to render. 'video_mux' produces a finished
   *  MP4: source video stream copied verbatim (-c:v copy) with a NEW audio track
   *  that is the 3-stem mix (dubbed + M&E + optional original dialogue) at the
   *  operator's fader levels, normalized. The worker renders the audio via
   *  /mix-final then muxes via /mux-video — one audio code path. */
  audio_mode?: 'full_mix' | 'per_speaker' | 'video_dub_me' | 'video_mux';
  /** [audio kind] EBU R128 loudness target (-16 | -23). Null/absent = raw mix.
   *  Applies only to full_mix / video_dub_me / video_mux; ignored for per_speaker. */
  loudness_target_lufs?: number | null;
  /** [audio kind, video_mux mode] The 3-stem mixing-console fader recipe, pinned
   *  verbatim. Faders control relative BLEND (dB); loudness_target_lufs controls
   *  absolute delivery loudness. Reproducible from the row alone (SOC 2 CC8.1). */
  mix_recipe?: {
    dub_gain_db: number;
    me_gain_db: number;
    /** Null/absent = original dialogue NOT mixed in. */
    original_dialogue_gain_db?: number | null;
    include_original_dialogue: boolean;
  } | null;
  /** [audio kind, video_mux mode] Which video stream to mux onto.
   *  'original' = full-res source (deliverable). 'proxy' = 720p editor proxy. */
  source_res?: 'original' | 'proxy';
  /** Scoped JWT bound to (user, export_job_id, 'exportProjectWorkerStep'). 30 min TTL. */
  auth_token: string;
}

// ─── v1 backup-snapshot payload (2026-05-15) ─────────────────────────
//
// Single-shot job. The worker paginates EVERY entity in ENTITIES into a
// single JSON file in S3, then calls backupSnapshotWorkerStep to record
// completion + prune old backups. Replaces the synchronous
// backupAllEntitiesToS3 which will timeout once the DB exceeds ~75k total
// rows (currently ~30k — comfortable but trending toward the ceiling).

export interface BackupSnapshotJobData {
  schema_version: number;
  /** Date stamp (YYYY-MM-DD) — used to mint the S3 folder. */
  date_stamp: string;
  /** Where to drop the backup files. */
  s3_bucket: string;
  s3_region: string;
  /** Entity names to back up. Producer freezes the list at enqueue time so the
   *  set is reproducible even if the schema changes mid-run. */
  entity_names: string[];
  /** How many recent backup folders to keep when pruning. */
  keep_last_n: number;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, date_stamp, 'backupSnapshotWorkerStep'). 30 min TTL. */
  auth_token: string;
}

// ─── Load-test-fanout payload (2026-05-18) ───────────────────────────
//
// Producer (Base44 fn `runPipelineLoadTest`)
//   → Validates auth (admin only) + resolves the load-test fixture project.
//   → Creates LoadTestRun row in 'running' status.
//   → Mints a scoped JWT bound to (admin_email, fixture_project_id,
//     load_test_run_id, 'loadTestFanoutWorkerStep'), 60-min TTL.
//   → Enqueues ONE LoadTestFanoutJobData onto LOAD_TEST_FANOUT.
//   → Returns { run_id } to the UI.
//
// Worker (`processLoadTestFanout`)
//   → Each tick calls Base44 fn `loadTestFanoutWorkerStep` with the inlined
//     plan + current state. The step:
//       • fires up to FANOUT_BATCH_PER_TICK producer calls (e.g.
//         enqueueTranslation per target language) with the configured stagger
//         between them — staying within its own 30s function budget
//       • appends results (child_run_ids, fanout_errors, enqueue_latencies_ms)
//         to LoadTestRun.metrics._driver via a single update
//       • returns next_state with the advanced dispatch_cursor OR
//         { finalized: true } when dispatch_cursor === concurrency_target
//   → Re-enqueues with a small delay between ticks until finalized.
//   → Once finalized, exits. finalizeLoadTestRun (scheduled every minute,
//     plus on-demand from the UI) aggregates metrics from the child runs.
//
// State carried forward across ticks via inlined_plan + state, identical
// pattern to VoiceGenOrchestratorJobData / AIRewriteOrchestratorJobData.

export interface LoadTestFanoutJobData {
  schema_version: number;
  /** LoadTestRun.id — the run this fan-out belongs to. */
  load_test_run_id: string;
  /** Fixture Project.id pinned at producer time. */
  fixture_project_id: string;
  /** Admin email that triggered the run (preserved for attribution + RBAC). */
  user_email: string;
  /** Correlation id threaded into every StructuredLog row for this run. */
  request_id: string;
  /** Scoped JWT bound to (user_email, fixture_project_id, load_test_run_id,
   *  'loadTestFanoutWorkerStep'). 60-min TTL — covers the longest expected
   *  fan-out (N=150 @ 30s stagger = ~75 min, but the harness clamps stagger
   *  × N to ≤60min via the worker-step). */
  auth_token: string;
  /** Immutable plan — frozen at producer time. */
  inlined_plan: {
    pipeline: 'translation' | 'voice_gen' | 'adaptation' | 'enrichment';
    /** Pipeline-specific provider key (e.g. 'gemini' for translation under
     *  load test — see runPipelineLoadTest for why DeepL is not used). */
    provider: string;
    concurrency_target: number;
    /** Requested stagger between producer calls in ms. */
    stagger_ms: number;
    /** Pipeline-specific payload templates. For translation:
     *    target_languages: string[]  (length === concurrency_target)
     *  For voice_gen: translation_segment_ids: string[]
     *  Other pipelines: pipeline-specific keys. */
    targets: Record<string, unknown>;
    started_at: string;
  };
  /** Mutable state — carried forward each tick. Empty on first tick. */
  state: {
    dispatch_cursor: number;
    tick_count: number;
  };
}

// ─── Load-test-cleanup payload (B8, 2026-05-21) ──────────────────────
//
// Producer (Base44 fn `enqueueLoadTestCleanup`)
//   → Validates admin role + fixture project name against hard allowlist.
//   → Creates LoadTestCleanupRun row in 'queued' status (or returns the
//     existing in-flight run if one already exists for this fixture —
//     idempotent by design).
//   → Mints a scoped JWT bound to (admin_email, fixture_project_id,
//     cleanup_run_id, 'loadTestCleanupWorkerStep'), 30-min TTL.
//   → Enqueues ONE LoadTestCleanupJobData onto LOAD_TEST_CLEANUP.
//   → Returns { cleanup_run_id, worker_job_id } to the UI.
//
// Worker (`processLoadTestCleanup`)
//   → Each tick calls Base44 fn `loadTestCleanupWorkerStep`. The step:
//       • Re-verifies the fixture project name against the allowlist
//         (defense-in-depth — never trust the payload alone).
//       • Deletes one page (≤200 rows) of the current_phase entity
//         bucket with 429-aware rate-limited delete helpers.
//       • Advances the phase machine when a bucket is drained.
//       • Returns next_tick OR finalized when current_phase === 'done'.
//   → Re-enqueues with a small delay until finalized.
//   → attempts=1 by design (same as load-test-fanout): retrying mid-tick
//     would re-issue deletes already in flight. The step function is
//     idempotent within its own boundary; we don't double down with
//     BullMQ retries.

export interface LoadTestCleanupJobData {
  schema_version: number;
  /** LoadTestCleanupRun.id — the cleanup pass this job advances. */
  cleanup_run_id: string;
  /** Fixture Project.id pinned at producer time. Must be one of the four
   *  allowlisted __loadtest_* projects; the step re-verifies on every tick. */
  fixture_project_id: string;
  /** Denormalized fixture project name for log/UI display. Audit-only. */
  fixture_project_name: string;
  /** Admin email that triggered the cleanup (preserved for attribution). */
  user_email: string;
  /** Correlation id threaded into every StructuredLog row for this run. */
  request_id: string;
  /** Scoped JWT bound to (user_email, fixture_project_id, cleanup_run_id,
   *  'loadTestCleanupWorkerStep'). 30-min TTL — comfortably covers a 5k-row
   *  cleanup (~3-8 min wall-clock under typical 429 pressure). */
  auth_token: string;
}

// ─── Load-test-reseed payload (2026-05-22) ───────────────────────────
//
// Mirrors LoadTestCleanupJobData exactly. The trust envelope and
// re-enqueue posture are identical; only the resource type (reseed_run_id)
// and step function (loadTestReseedWorkerStep) differ.

export interface LoadTestReseedJobData {
  schema_version: number;
  /** LoadTestReseedRun.id — the reseed pass this job advances. */
  reseed_run_id: string;
  /** Fixture Project.id pinned at producer time. Must be one of the four
   *  allowlisted __loadtest_* projects; the step re-verifies on every tick. */
  fixture_project_id: string;
  /** Denormalized fixture project name for log/UI display. Audit-only. */
  fixture_project_name: string;
  /** Admin email that triggered the reseed (preserved for attribution). */
  user_email: string;
  /** Correlation id threaded into every StructuredLog row for this run. */
  request_id: string;
  /** Scoped JWT bound to (user_email, fixture_project_id, reseed_run_id,
   *  'loadTestReseedWorkerStep'). 30-min TTL — comfortably covers a 25-language
   *  × 200-segment reseed (~3-8 min wall-clock under typical 429 pressure). */
  auth_token: string;
}

// ─── CC cue supersede payload (2026-05-28) ────────────────────────────
//
// Single-shot tick-resumable job. The worker calls ccCueSupersedeWorkerStep
// on each tick; the step paginates up to ~500 active CaptionCue rows,
// flips is_active=true → false via bulkUpdate with 429-aware retries,
// updates CCFormatRun.cue_supersede_progress (cursor + counters), and
// returns one of three actions:
//
//   action='continue'         → more cues remain; worker re-enqueues self
//   action='dispatch_engine'  → all cues superseded AND this run carries
//                               needs_engine_dispatch=true (initial_apply
//                               trigger only); worker invokes
//                               ccDispatchToEngine then exits
//   action='done'             → all cues superseded; no engine handoff
//                               (admin_cleanup / speaker_rename); CCFormatRun
//                               is already finalized status='completed'
//                               by the step itself
//
// When dispatch_engine fires the worker POSTs to ccDispatchToEngine on
// Base44 (NOT to Railway directly — single source of truth for the
// Railway api_key + signed URL lives in Base44). That function does the
// actual Railway POST, pins engine_job_id on the CCFormatRun + JobRun,
// flips Project.cc_status='transcribing', and returns. The worker then
// exits cleanly — the ccPollRailwayJobs scheduled function takes over
// to drive completion ingest.

export interface CCCueSupersedeJobData {
  schema_version: number;
  project_id: string;
  format_run_id: string;
  /** JobRun.id paired with this CCFormatRun (only present when this run
   *  is the initial_apply for a transcription — admin_cleanup and
   *  speaker_rename runs do not carry a JobRun). The step / dispatch
   *  function uses this to finalize the JobRun in lockstep with the
   *  CCFormatRun. */
  job_run_id?: string;
  /** True when this run is the initial_apply for a transcription and the
   *  worker should call ccDispatchToEngine after the supersede phase
   *  completes. False for admin_cleanup, speaker_rename, and any other
   *  trigger that wants supersede only. */
  needs_engine_dispatch: boolean;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, format_run_id, 'ccCueSupersedeWorkerStep').
   *  30-min TTL — comfortably covers a 1500-cue supersede (~3-8 min
   *  wall-clock under typical 429 pressure) plus the engine dispatch
   *  follow-up. */
  auth_token: string;
}

// ─── Transcript-import (AI-Dubbing REPLACE) payload (2026-06-09) ──────
//
// Single-shot tick-resumable job. The worker calls transcriptImportWorkerStep
// on each tick; the step walks a STAGE-THEN-FLIP phase machine:
//
//   phase 'staging_new'  → bulk-create up to ~150 NEW TranscriptSegment rows
//                          as is_active=false (tagged import_run_id) from the
//                          frozen parsed-segments snapshot in S3. Resumes from
//                          checkpoint.stage_cursor. Old rows untouched + visible.
//                          Returns action='continue' until all staged.
//   phase 'cutover'      → flip THIS run's staged rows is_active=false→true,
//                          then supersede the old TranscriptSegment /
//                          TranslationSegment / Speaker rows (is_active=true→
//                          false + superseded_by_run_id + superseded_at).
//   phase 'finalizing'   → update Project (status/workflow/counters), write
//                          ActivityLog, mark run completed. Returns action='done'.
//
// The parsed-segments payload NEVER travels through the BullMQ job body (Redis)
// — the producer writes it to S3 (parsed_segments_key) and the worker step
// reads it back. This keeps a 5000-line replace's payload off the queue.
//
// SECURITY MODEL — identical to cc-cue-supersede:
//   • Scoped JWT (30-min TTL) verified by transcriptImportWorkerStep.
//   • Bound to (user, project, transcript_import_run_id, fn).
//
// AUDIT POSTURE (SOC 2 CC7.2 / CC8.1):
//   • TranscriptImportRun is the audit row; current_phase + checkpoint answer
//     "how far did this replace get?" from a single row.
//   • BullMQ retains failed jobs 7d — every failed replace is DLQ-queryable.

export interface TranscriptImportJobData {
  schema_version: number;
  project_id: string;
  transcript_import_run_id: string;
  user_email: string;
  request_id: string;
  /** Scoped JWT bound to (user, project, transcript_import_run_id,
   *  'transcriptImportWorkerStep'). 30-min TTL — comfortably covers a
   *  5000-line stage-then-flip (~3-10 min wall-clock under 429 pressure). */
  auth_token: string;
}

// ─── GLTV cascade payload (Phase 2, 2026-06-12) ──────────────────────
//
// Single-shot tick-resumable job. The worker calls gltvCascadeWorkerStep on
// each tick; the step advances ONE phase transition and returns an action.
// The parsed pipeline config is NEVER in this payload — the step reads the
// FROZEN recipe_snapshot off DubbingApiJob (the reproducibility anchor), so
// the cascade is recipe-snapshot-driven, never live-recipe-driven.
//
// SECURITY MODEL — identical to cc-cue-supersede:
//   • Scoped JWT (60-min TTL) bound to (system, dubbing_api_job_id,
//     'gltvCascadeWorkerStep'). Worker forwards verbatim as X-Worker-JWT.
//
// AUDIT POSTURE (SOC 2 CC7.2 / CC8.1):
//   • DubbingApiJob is the audit row; status + phase_history + *_run_id answer
//     "what phase, under which run, with what cost?" from a single row.
//   • BullMQ retains failed jobs 7d — every failed cascade is DLQ-queryable.
export interface GltvCascadeJobData {
  schema_version: number;
  /** DubbingApiJob.id — the API job this cascade advances. */
  dubbing_api_job_id: string;
  /** Internal Project.id spawned for this job (tagged gltv_api). */
  project_id: string;
  /** Correlation id threaded into every StructuredLog row for this cascade. */
  request_id: string;
  /** Scoped JWT bound to (system, dubbing_api_job_id, 'gltvCascadeWorkerStep').
   *  60-min TTL — a single phase tick is short, but the cascade re-enqueues
   *  across many ticks; the producer mints a fresh JWT each (re-)enqueue. */
  auth_token: string;
}

// ─── Simple Translation (SRT) async translate payload (2026-06-16) ───────────
//
// Single-shot tick-resumable job. The worker calls srtTranslateWorkerStep in a
// loop; the step translates a bounded batch of pending TranslationCue rows and
// returns action='continue' (re-call) or action='done' (run finalized). The
// parsed cues are NEVER in this payload — the step reads them off the DB keyed
// by (project_id, cue_index > checkpoint.cursor). FULLY ISOLATED to the
// Translation module.
//
// SECURITY MODEL — identical to cc-cue-supersede / transcript-import:
//   • Scoped JWT (30-min TTL) bound to (user, project, run_id,
//     'srtTranslateWorkerStep'). Worker forwards verbatim as X-Worker-JWT.
//
// AUDIT POSTURE (SOC 2 CC7.2 / CC8.1):
//   • SimpleTranslationRun is the audit row; status + checkpoint answer "how far
//     did this translate get?" from a single row.
//   • BullMQ retains failed jobs 7d — every failed run is DLQ-queryable.
export interface SrtTranslateJobData {
  schema_version: number;
  /** Owning Project.id (project_type='simple_translation'). */
  project_id: string;
  /** SimpleTranslationRun.id — the run this job advances. */
  run_id: string;
  /** User that triggered the translate (preserved for attribution). */
  user_email: string;
  /** Correlation id threaded into every StructuredLog row for this run. */
  request_id: string;
  /** Scoped JWT bound to (user, project, run_id, 'srtTranslateWorkerStep').
   *  30-min TTL — comfortably covers a 3000-cue feature film (~10-20 ticks). */
  auth_token: string;
}

// ─── M&E poll heartbeat payload (2026-06-25) ─────────────────────────────────
//
// Single PERPETUAL self-rescheduling job. The worker calls pollAllActiveME (a
// thin loop) which, per tick, lists every Project with an active me_lalal token
// and calls the Base44 fn `pollMEStatus` once per project to drive it forward
// (harvest finished → S3 → ready; map LALAL error → failed; no-op if still
// processing). Then the worker re-enqueues ITSELF after ME_POLL_TICK_DELAY_MS.
//
// PORTABILITY (the whole point): the scheduler/heartbeat lives in the worker
// repo, so M&E is not dependent on a Base44-platform cron. The harvest logic
// itself stays in pollMEStatus (single source of truth, shared with the editor
// live poll) — invoked over the same scoped-JWT callback every processor uses.
//
// AUTH: a scoped JWT bound to (fn='pollMEStatus'). Because the sweep touches
// MANY projects per tick (not one resource), the token is fn-scoped only —
// pollMEStatus verifies the fn claim + signature and then acts as service-role
// (same trust envelope as the scheduled-admin path it replaces). The producer
// re-mints a fresh token each time it (re)seeds; the worker carries the token
// across self-reschedules and the producer reseeds it well before expiry via
// the long TTL below.
export interface MEPollJobData {
  schema_version: number;
  /** Correlation id threaded into StructuredLog rows for this heartbeat. */
  request_id: string;
  /** Scoped JWT bound to (fn='pollMEStatus'). Long TTL — this is a perpetual
   *  heartbeat; the producer reseeds with a fresh token periodically. */
  auth_token: string;
}

// Discriminated union for processors that need to handle multiple shapes.
export type AnyJobData =
   | VoiceGenJobData
   | VoiceGenOrchestratorJobData
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
   | ProxyGenJobData
   | ProjectCascadeJobData
   | ExportJobData
   | BackupSnapshotJobData
   | LoadTestFanoutJobData
   | LoadTestCleanupJobData
   | LoadTestReseedJobData
   | CCCueSupersedeJobData
   | TranscriptImportJobData
   | GltvCascadeJobData
   | SrtTranslateJobData
   | MEPollJobData;

// ─── Default per-queue options (used by both producer and consumer) ──

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 }, // 5s, 25s, 125s
  removeOnComplete: { age: 3600, count: 1000 },           // 1h or last 1000
  removeOnFail: { age: 86400 * 7 },                        // keep failed 7d
};

// Voice-gen per-segment jobs (2026-06-02). Deeper + longer than the default
// because the bottleneck is ElevenLabs' request-BURST limit, which can 429 for
// minutes at peak (100+ concurrent users). The default 3-attempt / 5s-25s-125s
// budget can have all 3 BullMQ attempts land inside the SAME sustained burst
// window and exhaust → the segment fails as provider_429. 5 attempts with a
// 10s base (10s/40s/160s/...) spreads the retries across a wider window so a
// transient burst clears between attempts. Combined with (a) the worker's new
// start-rate limiter, (b) the in-function 6-attempt retry, and (c) the global
// concurrency semaphore, this is the four-layer provider-pressure relief.
// generateOneSegment is idempotent per-segment (skips already-ready rows), so
// a retry of a segment whose prior attempt actually succeeded is a safe no-op.
// SOC 2 CC7.4 — bounded retry traces to a real provider-pressure observation;
// every retry + DLQ entry is auditable via BullMQ failedReason. Revertable in
// <60s by reverting to DEFAULT_JOB_OPTIONS at the enqueue call site.
export const VOICE_GEN_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10000 }, // 10s, 40s, 160s, …
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 * 7 },                          // keep failed 7d for DLQ
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

// Project cascade: same posture as proxy-gen (expensive operation, 1 retry).
// Each cascade does many row-level SDK deletes, so 2 attempts is sufficient
// to handle transient network blips while not burning rate budget on a
// doomed retry.
export const PROJECT_CASCADE_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 30000 },
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 86400 * 7 },
};

// Export: short retry budget (2 attempts). Exports are idempotent — re-running
// the same job produces the same S3 object at the same key, so a retry is
// cheap and safe. Transient SDK pagination blips DO happen at scale, so we
// give one bounded retry before DLQ.
export const EXPORT_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 10000 },
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 86400 * 7 },
};

// Backup: same as export — idempotent (same date_stamp → same S3 path), so
// one retry is safe. Backups are weekly, so DLQ retention of 7 days catches
// a Monday failure before the next attempt the following week.
export const BACKUP_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 60000 },
  removeOnComplete: { age: 86400 * 7, count: 50 },
  removeOnFail: { age: 86400 * 14 },
};

// GLTV cascade (Phase 2, 2026-06-12). Conservative — like the orchestrators,
// a wedged cascade needs human eyes, not infinite re-ticks. attempts=2 means
// one retry then DLQ. The cascade re-enqueues ITSELF for each tick (the step
// returns action='continue'/'advance'), so a single job's attempt budget only
// covers a hard failure of ONE tick, not the whole pipeline. Idempotent by
// design (start-or-poll keyed by *_run_id) so a retried tick is a safe no-op.
// SOC 2 CC7.4 — bounded retry; every DLQ entry is auditable via BullMQ
// failedReason + the DubbingApiJob.phase_history row.
export const GLTV_CASCADE_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 10000 },
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 86400 * 7 },
};

// M&E poll heartbeat (2026-06-25). attempts:1 — the heartbeat re-enqueues its
// OWN next tick (deterministic jobId 'me-poll-singleton'); a failed tick must
// NOT be BullMQ-retried (that would race a second perpetual loop). If a tick
// throws, the next reseed from enqueueMEPoll restores the heartbeat. Short
// retention because there's only ever one live job + its immediate successor.
// SOC 2 CC7.2 — bounded, single-loop, resumable via reseed.
export const ME_POLL_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 600, count: 5 },
  removeOnFail: { age: 86400 },
};

// ─── Project cascade payload (2026-05-15) ────────────────────────────
//
// Single-shot job. The worker loops through all project-scoped entities,
// paginating + deleting rows in bounded batches (20 parallel within each
// entity), then deletes the Project row and calls projectCascadeWorkerStep
// to write the audit log.
//
// SECURITY MODEL:
//   • Scoped JWT (2h TTL) verified by projectCascadeWorkerStep.
//   • S3 creds resolved from storage profile prefix in worker env.
//
// AUDIT POSTURE (SOC 2 CC6.7 / CC8.1):
//   • ActivityLog row + StructuredLog rows written by finalizer.
//   • BullMQ retains failed jobs for 7 days — every failed cascade is
//     queryable from the Compliance DLQ panel.

export interface ProjectCascadeJobData {
  schema_version: number;
  project_id: string;
  project_name: string;
  user_email: string;
  request_id: string;
  storage: {
    bucket: string;
    region: string;
    credential_secret_prefix: string;
    media_key?: string;
    me_track_key?: string;
    proxy_video_key?: string;
    proxy_audio_key?: string;
  };
  /** Scoped JWT bound to (user, project_id, 'projectCascadeWorkerStep'). 2h TTL. */
  auth_token: string;
}
