// =============================================================================
// ADAPT-CHUNK PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `adaptChunk` function. ONE invocation = ONE chunk:
//   • base_translation  → ≤50 (DeepL) or ≤30 (Gemini) source segments
//   • retranslate_all   → ≤50 (DeepL) or ≤30 (Gemini) adaptation segments
//   • generate_adaptation → ≤5 adaptation segments (LLM per record)
//
// Heartbeats: per-chunk wall time can hit 50s for generate_adaptation; the
// 90s timeout is the network-side ceiling. Lock extended every 15s.
//
// Idempotency: re-runs short-circuit on completed_chunk_keys.
// =============================================================================

import type { Job } from 'bullmq';
import type { AdaptChunkJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const HEARTBEAT_MS = 15_000;
const CHUNK_TIMEOUT_MS = 90_000;

export async function processAdaptChunk(job: Job<AdaptChunkJobData>) {
  const t0 = Date.now();
  const {
    project_id, adaptation_run_id, chunk_key, chunk_index,
    source_segment_ids, adaptation_segment_ids,
    user_email, request_id, auth_token,
  } = job.data;

  if (!auth_token) {
    throw new Error('adapt-chunk: missing auth_token (re-enqueue required)');
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
      fn: 'adaptChunk',
      authToken: auth_token,
      payload: {
        project_id,
        adaptation_run_id,
        chunk_key,
        chunk_index,
        source_segment_ids,
        adaptation_segment_ids,
        request_id,
      },
      timeoutMs: CHUNK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:adapt-chunk',
      event: 'adapt_chunk_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, adaptation_run_id, chunk_key, chunk_index,
        record_count: (source_segment_ids?.length || 0) + (adaptation_segment_ids?.length || 0),
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:adapt-chunk',
      level: 'error',
      event: 'adapt_chunk_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        project_id, adaptation_run_id, chunk_key, chunk_index,
        record_count: (source_segment_ids?.length || 0) + (adaptation_segment_ids?.length || 0),
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