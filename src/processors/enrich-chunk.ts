// =============================================================================
// ENRICH-CHUNK PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `enrichChunk` function. Each invocation processes
// ONE scene-chunk (≤20 records) end to end:
//
//   - LLM enrichment call (temp 0, prompt-versioned, with canon + synopsis).
//   - Per-annotation self-verification pass.
//   - Canon conflict resolution.
//   - Bucket routing + annotation writes (with idempotency_key).
//   - Atomic update of run counters (decrements chunk_in_flight,
//     increments chunk_completed, adds chunk_key to completed_chunk_keys).
//
// Idempotency: if BullMQ re-runs us (same chunk_key), the Base44 function
// short-circuits because chunk_key is already in run.checkpoint
// .completed_chunk_keys.
//
// Heartbeats: same pattern as the orchestrator — the LLM calls can run 30-50s,
// and we don't want the BullMQ lock to expire mid-call.
// =============================================================================

import type { Job } from 'bullmq';
import type { EnrichChunkJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const HEARTBEAT_MS = 15_000;
// Chunks can take up to ~60s on master tier (enrichment + verification +
// canon resolution). 90s timeout is the network ceiling.
const CHUNK_TIMEOUT_MS = 90_000;

export async function processEnrichChunk(job: Job<EnrichChunkJobData>) {
  const t0 = Date.now();
  const {
    project_id, enrichment_run_id, chunk_key, scene_id, chunk_index,
    record_ids, user_email, request_id, auth_token,
  } = job.data;

  if (!auth_token) {
    throw new Error('enrich-chunk: missing auth_token (re-enqueue required)');
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
      fn: 'enrichChunk',
      authToken: auth_token,
      payload: {
        project_id,
        enrichment_run_id,
        chunk_key,
        scene_id,
        chunk_index,
        record_ids,
        request_id,
      },
      timeoutMs: CHUNK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:enrich-chunk',
      event: 'enrich_chunk_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, enrichment_run_id, chunk_key, scene_id,
        record_count: record_ids.length,
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:enrich-chunk',
      level: 'error',
      event: 'enrich_chunk_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        project_id, enrichment_run_id, chunk_key, scene_id,
        record_count: record_ids.length,
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