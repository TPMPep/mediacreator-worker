// =============================================================================
// AIREWRITE-CHUNK PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `rewriteChunk` function. Each invocation processes
// ONE chunk (≤10 translations, one LLM call per line, CPS-verified):
//
//   - Per-line LLM call (prompt versioned, model pinned, full context).
//   - On overshoot (shorten still > MAX or expand still < MIN), single retry
//     with tightened/looser budget — same logic as the single-line hot path.
//   - Idempotent persist: re-running the chunk is safe because the Base44
//     function checks completed_chunk_keys on the run document.
//   - Atomic update of run counters (succeeded_count/failed_count/cost_usd,
//     chunk_completed++, chunk_in_flight--, chunk_key in completed_chunk_keys).
//
// Idempotency: BullMQ may re-run us (same chunk_key). The Base44 function
// short-circuits if chunk_key is already in completed_chunk_keys.
//
// Heartbeats: a chunk of 10 LLM calls with retries can run 30-60s. We extend
// the lock every 15s.
// =============================================================================

import type { Job } from 'bullmq';
import type { AIRewriteChunkJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const HEARTBEAT_MS = 15_000;
// Chunks: 10 LLM calls × up to 2 retries each × ~3s = ~60s worst case.
const CHUNK_TIMEOUT_MS = 90_000;

export async function processAIRewriteChunk(job: Job<AIRewriteChunkJobData>) {
  const t0 = Date.now();
  const {
    project_id, rewrite_run_id, chunk_key, chunk_index,
    translation_ids, mode, user_email, request_id, auth_token,
  } = job.data;

  if (!auth_token) {
    throw new Error('airewrite-chunk: missing auth_token (re-enqueue required)');
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
      fn: 'rewriteChunk',
      authToken: auth_token,
      payload: {
        project_id,
        rewrite_run_id,
        chunk_key,
        chunk_index,
        translation_ids,
        mode,
        request_id,
      },
      timeoutMs: CHUNK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:airewrite-chunk',
      event: 'airewrite_chunk_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, rewrite_run_id, chunk_key, chunk_index, mode,
        line_count: translation_ids.length,
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:airewrite-chunk',
      level: 'error',
      event: 'airewrite_chunk_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        project_id, rewrite_run_id, chunk_key, chunk_index, mode,
        line_count: translation_ids.length,
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
