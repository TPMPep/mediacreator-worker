// =============================================================================
// TRANSLATE-CHUNK PROCESSOR (v4-rev2, 2026-05-09)
// -----------------------------------------------------------------------------
// Calls back into Base44's `translateChunk`. The Base44 fn is now PURE
// COMPUTE — it returns the translation result as JSON, makes ZERO Base44
// entity writes. We RETURN that JSON to BullMQ so it persists as
// `Job.returnvalue`. The orchestrator harvests it on the next tick via
// the worker's /job-status endpoint and writes everything atomically.
//
// Terminal errors (DeepL 456, malformed input) come back as
// `{ ok: false, terminal_error: {...} }` — we still RETURN them (don't
// throw). BullMQ marks the job complete; the orchestrator classifies the
// failure on harvest. This is correct: terminal errors should NEVER consume
// retry budget.
//
// Transient errors (network, 5xx, exhausted retries inside the chunk
// function) → fn returns 500 → invokeBase44Function throws → we throw →
// BullMQ retries up to 3× per the queue contract.
// =============================================================================

import type { Job } from 'bullmq';
import type { TranslateChunkJobData, TranslateChunkResult } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';

const CHUNK_TIMEOUT_MS = 90_000;

export async function processTranslateChunk(job: Job<TranslateChunkJobData>): Promise<TranslateChunkResult> {
  const t0 = Date.now();
  const {
    project_id, translation_run_id, chunk_key, chunk_index,
    segments, provider, source_language_code, target_language_code,
    target_language_label, formality, context,
    user_email, request_id, auth_token,
  } = job.data;

  if (!auth_token) {
    throw new Error('translate-chunk: missing auth_token (re-enqueue required)');
  }

  try {
    // runWithLockHeartbeat owns the lock-renewal loop and aborts the invocation
    // via `signal` the instant the BullMQ lock is lost — no zombie can run
    // parallel to a reclaim. See base44-client.ts for the full rationale.
    const result = await runWithLockHeartbeat<TranslateChunkResult>(job, (signal) =>
      invokeBase44Function<TranslateChunkResult>({
        fn: 'translateChunk',
        authToken: auth_token,
        payload: {
          project_id,
          translation_run_id,
          chunk_key,
          chunk_index,
          segments,
          provider,
          source_language_code,
          target_language_code,
          target_language_label,
          formality,
          context,
          request_id,
        },
        timeoutMs: CHUNK_TIMEOUT_MS,
        signal,
      }),
    );

    await logEvent({
      function_name: 'bullmq:translate-chunk',
      event: result.ok ? 'translate_chunk_complete' : 'translate_chunk_terminal_error',
      level: result.ok ? 'info' : 'warn',
      duration_ms: Date.now() - t0,
      context: {
        project_id, translation_run_id, chunk_key, chunk_index,
        segment_count: segments?.length || 0,
        attempts: job.attemptsMade + 1,
        ok: result.ok,
        translated_count: result.translated_count,
        failed_count: result.failed_count,
        terminal_error_code: result.terminal_error?.code,
        request_id, user_email,
      },
    });

    // RETURN — do not throw on terminal_error. Orchestrator harvests this
    // returnvalue on the next tick. Throwing would consume retry budget
    // for an error that retrying cannot fix.
    return result;
  } catch (err) {
    const e = err as Error;
    const lockLost = e instanceof WorkerLockLostError;
    // Read off the un-narrowed Error — the instanceof check narrows the false
    // branch to `never` (WorkerLockLostError is structurally identical to Error).
    const errName: string = e.name;
    const errMessage: string = e.message;
    await logEvent({
      function_name: 'bullmq:translate-chunk',
      level: lockLost ? 'warn' : 'error',
      event: lockLost ? 'translate_chunk_lock_lost' : 'translate_chunk_failed',
      message: errMessage,
      error_kind: lockLost ? 'lock_lost' : errName,
      duration_ms: Date.now() - t0,
      context: {
        project_id, translation_run_id, chunk_key, chunk_index,
        segment_count: segments?.length || 0,
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    // Re-throw so BullMQ owns the single reclaim. A lock-loss abort is a clean
    // exit of THIS invocation, not a provider failure — the chunk is idempotent
    // and the reclaim re-runs it exactly once.
    throw err;
  }
}
