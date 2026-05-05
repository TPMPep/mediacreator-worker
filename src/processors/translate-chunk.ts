// =============================================================================
// TRANSLATE-CHUNK PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `translateChunk` function. Each invocation
// processes ONE chunk (≤50 segments for DeepL/variant, ≤20 for LLM):
//
//   - Single provider call for the whole chunk batch.
//   - Bulk-create TranslationSegment records.
//   - Atomic update of run counters (chunk_completed++, chunk_in_flight--,
//     chunk_key appended to completed_chunk_keys).
//   - Per-chunk CostLog write so partial-failure runs still bill correctly.
//
// Idempotency: BullMQ may re-run us (same chunk_key). The Base44 function
// short-circuits if chunk_key is already in completed_chunk_keys.
//
// Heartbeats: provider calls (especially LLM with retries) can run 30-50s.
// We extend the lock every 15s to avoid duplicate processing.
// =============================================================================

import type { Job } from 'bullmq';
import type { TranslateChunkJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const HEARTBEAT_MS = 15_000;
// Chunks: DeepL is fast (~3s/50), LLM with retries can hit 60s.
const CHUNK_TIMEOUT_MS = 90_000;

export async function processTranslateChunk(job: Job<TranslateChunkJobData>) {
  const t0 = Date.now();
  const {
    project_id, translation_run_id, chunk_key, chunk_index,
    segment_ids, user_email, request_id, auth_token,
  } = job.data;

  if (!auth_token) {
    throw new Error('translate-chunk: missing auth_token (re-enqueue required)');
  }

  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try { await job.extendLock(job.token!, 30_000); } catch { /* swallow */ }
    }
  })();

  try {
    const result = await invokeBase44Function({
      fn: 'translateChunk',
      authToken: auth_token,
      payload: {
        project_id,
        translation_run_id,
        chunk_key,
        chunk_index,
        segment_ids,
        request_id,
      },
      timeoutMs: CHUNK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:translate-chunk',
      event: 'translate_chunk_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, translation_run_id, chunk_key, chunk_index,
        segment_count: segment_ids.length,
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:translate-chunk',
      level: 'error',
      event: 'translate_chunk_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        project_id, translation_run_id, chunk_key, chunk_index,
        segment_count: segment_ids.length,
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}