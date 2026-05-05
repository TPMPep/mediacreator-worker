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
  BATCH_TRANSLATE: 'batch-translate',
  // Legacy single-shot enrichment queue. Retained for backwards compat with
  // any in-flight v1 jobs; new producers should target the orchestrator/chunk
  // queues below instead.
  BATCH_ENRICH: 'batch-enrich',
  // v2 enrichment pipeline — producer/orchestrator/chunk model.
  ENRICH_ORCHESTRATOR: 'enrich-orchestrator',
  ENRICH_CHUNK: 'enrich-chunk',
  SRT_IMPORT: 'srt-import',
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

export interface BatchTranslateJobData {
  schema_version: number;
  project_id: string;
  segment_ids: string[];
  target_language: string;
  provider: 'deepl' | 'gemini' | 'chatgpt';
  user_email: string;
  request_id: string;
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

export interface SrtImportJobData {
  schema_version: number;
  project_id: string;
  s3_key: string;
  user_email: string;
  request_id: string;
}

// Discriminated union for processors that need to handle multiple shapes.
export type AnyJobData =
  | VoiceGenJobData
  | BatchTranslateJobData
  | BatchEnrichJobData
  | EnrichOrchestratorJobData
  | EnrichChunkJobData
  | SrtImportJobData;

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