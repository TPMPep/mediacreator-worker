// =============================================================================
// ENRICH-ORCHESTRATOR PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `orchestrateEnrichmentRun` function. That function
// is the brain of the v2 enrichment pipeline:
//
//   - Reads the SuperscriptEnrichmentRun checkpoint.
//   - Advances the scene_cursor by a small batch (configured server-side).
//   - For each scene in the batch, enqueues N enrich-chunk jobs.
//   - If more scenes remain, asks the worker to re-enqueue this orchestrator
//     for the next tick (returned as `next_tick: true` in the response).
//   - If everything is dispatched AND no chunks are in flight, finalizes
//     the run (status -> completed/partial/failed) and returns
//     `finalized: true`.
//
// This worker stays dumb: it just forwards the call, honours `next_tick`, and
// keeps its lock alive via heartbeats. All business logic lives on Base44.
//
// Heartbeat: BullMQ jobs have a default 30s lock. Long-running calls back to
// Base44 (≤50s ceiling, but tail latency happens) can outlive that lock,
// causing duplicate processing. We extend the lock every 15s while waiting.
// =============================================================================

import type { Job } from 'bullmq';
import type { EnrichOrchestratorJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

// One re-enqueue queue handle; cheap to keep around.
let _orchestratorQueue: Queue | null = null;
function orchestratorQueue(): Queue {
  if (!_orchestratorQueue) {
    _orchestratorQueue = new Queue(QUEUE_NAMES.ENRICH_ORCHESTRATOR, { connection: getRedis() });
  }
  return _orchestratorQueue;
}

const HEARTBEAT_MS = 15_000;
// Hard ceiling on a single tick — if Base44 hasn't returned in 90s, abort and
// let BullMQ retry. The Base44 fn's own internal budget is 50s; this is the
// network-side safety net.
const TICK_TIMEOUT_MS = 90_000;

interface OrchestratorTickResult {
  next_tick?: boolean;
  /** Optional delay (ms) before the next tick. Default 1s. */
  next_tick_delay_ms?: number;
  finalized?: boolean;
  status?: string;
  scene_cursor?: number;
  scene_total?: number;
  chunks_dispatched?: number;
  chunk_in_flight?: number;
}

export async function processEnrichOrchestrator(job: Job<EnrichOrchestratorJobData>) {
  const t0 = Date.now();
  const { project_id, enrichment_run_id, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('enrich-orchestrator: missing auth_token (re-enqueue required)');
  }

  // Heartbeat the lock for as long as we're waiting on Base44.
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
      fn: 'orchestrateEnrichmentRun',
      authToken: auth_token,
      payload: { project_id, enrichment_run_id, request_id },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:enrich-orchestrator',
      event: 'orchestrator_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, enrichment_run_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
        next_tick: !!result.next_tick,
        finalized: !!result.finalized,
        scene_cursor: result.scene_cursor,
        scene_total: result.scene_total,
        chunks_dispatched: result.chunks_dispatched,
        chunk_in_flight: result.chunk_in_flight,
      },
    });

    // Re-enqueue ourselves if Base44 says there's more to do. We mint a *new*
    // scoped JWT each tick on the Base44 side; here we just forward the same
    // token until expiry, then the next tick's orchestrator call returns a
    // refreshed token. To keep things simple v1 reuses the same token (still
    // valid for the configured TTL — 30 min covers many ticks).
    if (result.next_tick && !result.finalized) {
      const delay = Math.max(500, Math.min(10_000, result.next_tick_delay_ms ?? 1_000));
      await orchestratorQueue().add(
        QUEUE_NAMES.ENRICH_ORCHESTRATOR,
        { ...job.data, request_id }, // same payload (incl. auth_token)
        // attempts=1: orchestrator retries cause counter drift (see
        // enqueueEnrichSuperscript for the full rationale).
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
    }

    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:enrich-orchestrator',
      level: 'error',
      event: 'orchestrator_tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, enrichment_run_id, user_email, request_id, attempts: job.attemptsMade + 1 },
    });
    throw err; // BullMQ retry
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}