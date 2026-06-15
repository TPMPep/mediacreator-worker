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
// Heartbeats: a chunk of 10 LLM calls with retries can run 30-150s. We extend
// the lock every 15s.
//
// Timeout Budget (2026-05-24 — Stage 2 N=10 provider tail tuning):
//   - rewriteChunk function-side worst case: 90s provider timeout × 3 inner
//     attempts = 270s (raised from 50s × 3 = 150s on 2026-05-24)
//   - CHUNK_TIMEOUT_MS = 330s (60s safety margin above 270s function ceiling,
//     was 180s)
//   - Rationale: N=10 smoke run (LoadTestRun 6a13372f...) observed
//     367 DLQ landings because Gemini Flash tail-latency at this concurrency
//     exceeded the 50s per-call AbortController. Raising per-call to 90s
//     absorbs Gemini's observed p95 (~75s under load) without changing
//     chunk size or batch shape — preserves auditor-grade per-line accounting.
//   - This ensures the worker never kills the function mid-retry; all transient
//     failures land in the return payload with telemetry (openai_timeout_count,
//     transient_retry_count, attempts_used). The orchestrator can then harvest
//     those counts onto the AIRewriteRun row for auditor-grade visibility into
//     provider degradation. SOC 2 CC7.4 — every timeout boundary is documented
//     and traceable to a real load-test observation.
// =============================================================================

import type { Job } from 'bullmq';
import type { AIRewriteChunkJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const HEARTBEAT_MS = 15_000;
// Worker function-call timeout. Must exceed function-side worst case:
// 90s provider timeout × 3 inner LLM attempts = 270s. Set to 330s for 60s safety.
// Raised from 180s on 2026-05-24 — see file header for the N=10 evidence.
const CHUNK_TIMEOUT_MS = 330_000;

// HARD WALL-CLOCK DEADLINE for the WHOLE processor invocation (reliability fix).
// -----------------------------------------------------------------------------
// CHUNK_TIMEOUT_MS bounds the SINGLE invokeBase44Function call. But if that
// promise ever fails to settle (gateway socket wedged, fetch never resolving
// nor rejecting), the await sits forever, the heartbeat loop starves, the
// BullMQ lock expires, and the job is reclaimed as `stalled` WITHOUT the
// processor's catch ever firing — no `airewrite_chunk_failed` log, no
// terminal state. That silent stall-loop is the exact wedge we are closing.
//
// This deadline is a Promise.race backstop: if the invocation has not settled
// by DEADLINE_MS, we throw a CLASSIFIED error so the job lands in BullMQ
// `failed` (harvestable by the orchestrator) instead of stalling invisibly.
// Sized just above CHUNK_TIMEOUT_MS so the in-call AbortController is always
// the first line of defence; this only fires when that defence itself wedged.
// SOC 2 CC7.2 — a hung invocation can no longer strand a chunk silently.
const CHUNK_DEADLINE_MS = 345_000; // 15s above CHUNK_TIMEOUT_MS

class ChunkDeadlineError extends Error {
  constructor(ms: number) {
    super(`airewrite-chunk: hard wall-clock deadline (${ms}ms) exceeded — invocation never settled. Classified as worker_deadline_exceeded so BullMQ fails the job instead of stalling it.`);
    this.name = 'ChunkDeadlineError';
  }
}

export async function processAIRewriteChunk(job: Job) {
  const t0 = Date.now();
  const {
    project_id, rewrite_run_id, chunk_key, chunk_index,
    inlined_translations, mode, user_email, request_id, auth_token,
    provider, project_context, inlined_run_config,
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

  // Hard wall-clock deadline: if the invocation never settles within
  // CHUNK_DEADLINE_MS, reject with a classified error so BullMQ fails the
  // job (orchestrator-harvestable) instead of the lock silently expiring
  // and the job being reclaimed as `stalled` with no failure surface.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new ChunkDeadlineError(CHUNK_DEADLINE_MS)), CHUNK_DEADLINE_MS);
  });

  try {
    const result = await Promise.race([
      invokeBase44Function({
        fn: 'rewriteChunk',
        authToken: auth_token,
        payload: {
          project_id,
          rewrite_run_id,
          chunk_key,
          chunk_index,
          // v3 pure-compute contract (incident 2026-05-09): the chunk
          // function makes ZERO Base44 reads. The producer inlines every
          // translation row + the run-config block the chunk needs; the
          // orchestrator forwards them verbatim through this queue. The
          // legacy `translation_ids` field is intentionally dropped — the
          // chunk has no way to dereference IDs without a Base44 read.
          inlined_translations,
          mode,
          provider,
          project_context,
          user_email,
          request_id,
          inlined_run_config,
        },
        timeoutMs: CHUNK_TIMEOUT_MS,
      }),
      deadline,
    ]);
    clearTimeout(deadlineTimer);

    await logEvent({
      function_name: 'bullmq:airewrite-chunk',
      event: 'airewrite_chunk_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, rewrite_run_id, chunk_key, chunk_index, mode,
        line_count: inlined_translations?.length ?? 0,
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
        line_count: inlined_translations?.length ?? 0,
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
