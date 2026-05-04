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

export const JOB_SCHEMA_VERSION = 1;

export const QUEUE_NAMES = {
  VOICE_GEN: 'voice-gen',
  BATCH_TRANSLATE: 'batch-translate',
  BATCH_ENRICH: 'batch-enrich',
  SRT_IMPORT: 'srt-import',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

// ─── Payload shapes ───────────────────────────────────────────────────

export interface VoiceGenJobData {
  schema_version: number;
  project_id: string;
  // The TranslationSegment id (NOT the source TranscriptSegment id).
  // Named `segment_id` for backward compatibility with v1 — semantically it's
  // the translation segment to render.
  segment_id: string;
  target_language: string;
  voice_id: string;
  // Full per-segment context that generateOneSegment needs to produce
  // identical output to the legacy inline path. The orchestrator resolves
  // these from Speaker/voice_assignments + style_settings + neighboring
  // translations and bakes them into the job so the worker doesn't need
  // to re-read entities.
  voice_settings?: Record<string, unknown>;
  voice_mode?: 'synthesis' | 'cloning' | 'modeling';
  is_cloned?: boolean;
  previous_text?: string | null;
  next_text?: string | null;
  segment_duration_ms?: number;
  performance_prompt?: string | null;
  cue_stability?: number | null;
  // Tracking fields for audit + retry semantics.
  user_email: string;
  request_id: string;
  // Scoped JWT minted by the producer (runVoiceGeneration). Worker forwards
  // it as X-Worker-JWT when calling generateOneSegment back. The token is
  // bound to (user_email, project_id, segment_id, 'generateOneSegment') and
  // expires in 15 min. Replaces the legacy long-lived service token. See
  // functions/_lib_workerJWT for the security model.
  auth_token?: string;
  // Optional priority hint (BullMQ priority is a separate option; keep this
  // for tagging/logging only).
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

export interface BatchEnrichJobData {
  schema_version: number;
  project_id: string;
  record_ids: string[];
  tier: 'draft' | 'standard' | 'master';
  enrichment_run_id: string;
  user_email: string;
  request_id: string;
}

export interface SrtImportJobData {
  schema_version: number;
  project_id: string;
  s3_key: string; // SRT file already uploaded; worker reads via signed URL
  user_email: string;
  request_id: string;
}

// Discriminated union for processors that need to handle multiple shapes.
export type AnyJobData =
  | VoiceGenJobData
  | BatchTranslateJobData
  | BatchEnrichJobData
  | SrtImportJobData;

// ─── Default per-queue options (used by both producer and consumer) ──

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 }, // 5s, 25s, 125s
  removeOnComplete: { age: 3600, count: 1000 },           // 1h or last 1000
  removeOnFail: { age: 86400 * 7 },                        // keep failed 7d
};