// =============================================================================
// TRANSLATE-ORCHESTRATOR PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `orchestrateTranslationRun`. That function is the
// brain of the v2 translation pipeline:
//
//   - Reads the TranslationRun checkpoint.
//   - Advances chunk_cursor by a small batch and dispatches translate-chunk
//     jobs.
//   - If more chunks remain, asks the worker to re-enqueue this orchestrator
//     for the next tick (returned as `next_tick: true`).
//   - When all chunks dispatched AND chunk_completed >= chunk_total,
//     finalizes the run and returns `finalized: true`.
//
// Mirrors enrich-orchestrator's design exactly — same heartbeat pattern, same
// auth model (scoped JWT forwarded as X-Worker-JWT), same retry policy
// (attempts: 1 to avoid counter drift on partial ticks).
// =============================================================================

import type { Job } from 'bullmq';
import type { TranslateOrchestratorJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

let _orchestratorQueue: Queue | null = null;
function orchestratorQueue(): Queue {
  if (!_orchestratorQueue) {
    _orchestratorQueue = new Queue(QUEUE_NAMES.TRANSLATE_ORCHESTRATOR, { connection: getRedis() });
  }
  return _orchestratorQueue;
}

const HEARTBEAT_MS = 15_000;
// Hard ceiling on a single tick. Base44 fn aims to finish in ≤45s; this is the
// network-side safety net.
const TICK_TIMEOUT_MS = 90_000;

interface OrchestratorTickResult {
  next_tick?: boolean;
  next_tick_delay_ms?: number;
  finalized?: boolean;
  status?: string;
  chunk_cursor?: number;
  chunk_total?: number;
  chunks_dispatched?: number;
  chunk_in_flight?: number;
  chunk_completed?: number;
}

export async function processTranslateOrchestrator(job: Job<TranslateOrchestratorJobData>) {
  const t0 = Date.now();
  const { project_id, translation_run_id, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('translate-orchestrator: missing auth_token (re-enqueue required)');
  }

  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try { await job.extendLock(job.token!, 30_000); } catch { /* lock may have already advanced */ }
    }
  })();

  try {
    const result = await invokeBase44Function<OrchestratorTickResult>({
      fn: 'orchestrateTranslationRun',
      authToken: auth_token,
      payload: { project_id, translation_run_id, request_id },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:translate-orchestrator',
      event: 'translate_orchestrator_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, translation_run_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
        next_tick: !!result.next_tick,
        finalized: !!result.finalized,
        chunk_cursor: result.chunk_cursor,
        chunk_total: result.chunk_total,
        chunks_dispatched: result.chunks_dispatched,
        chunk_in_flight: result.chunk_in_flight,
        chunk_completed: result.chunk_completed,
      },
    });

    if (result.next_tick && !result.finalized) {
      const delay = Math.max(500, Math.min(10_000, result.next_tick_delay_ms ?? 1_000));
      await orchestratorQueue().add(
        QUEUE_NAMES.TRANSLATE_ORCHESTRATOR,
        { ...job.data, request_id },
        // attempts=1: orchestrator retries cause counter drift (see
        // enqueueTranslation for the full rationale — same lesson as Day 1).
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
    }

    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:translate-orchestrator',
      level: 'error',
      event: 'translate_orchestrator_tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, translation_run_id, user_email, request_id, attempts: job.attemptsMade + 1 },
    });
    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}