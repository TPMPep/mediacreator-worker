// =============================================================================
// AIREWRITE-ORCHESTRATOR PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `orchestrateAIRewriteRun`. That function is the
// brain of the v2 bulk AI-rewrite pipeline:
//
//   - Reads the AIRewriteRun checkpoint.
//   - SOFT-STOP cost-cap enforcement: if cumulative cost_usd ≥ cost_cap_usd,
//     marks cost_cap_breached=true and STOPS dispatching new chunks. Does
//     NOT immediately finalise — in-flight chunks finish normally and their
//     results commit. The orchestrator finalises as 'partial' on the next
//     tick, when chunks_terminal >= chunks_dispatched. Final cost may push
//     ~ $0.30 worst-case past the cap (chunk_size × per-line cost).
//   - Advances chunk_cursor by a small batch and dispatches airewrite-chunk
//     jobs (skipping idempotent already-completed ones).
//   - If more chunks remain, asks the worker to re-enqueue this orchestrator
//     for the next tick (returned as `next_tick: true`).
//   - When all dispatched AND chunks_terminal >= chunk_total, finalises the
//     run and returns `finalized: true`.
//
// Mirrors translate-orchestrator's design — same heartbeat pattern, same
// auth model (scoped JWT forwarded as X-Worker-JWT), same retry policy
// (attempts: 1 to avoid counter drift on partial ticks).
// =============================================================================

import type { Job } from 'bullmq';
import type { AIRewriteOrchestratorJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

let _orchestratorQueue: Queue | null = null;
function orchestratorQueue(): Queue {
  if (!_orchestratorQueue) {
    _orchestratorQueue = new Queue(QUEUE_NAMES.AIREWRITE_ORCHESTRATOR, { connection: getRedis() });
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
  chunks_terminal?: number;
  cost_cap_breached?: boolean;
  cost_usd?: number;
  cost_cap_usd?: number | null;
  /** v3 inlined-payload: post-tick state snapshot to carry into next tick. */
  next_state?: AIRewriteOrchestratorJobData['state'];
}

export async function processAIRewriteOrchestrator(job: Job<AIRewriteOrchestratorJobData>) {
  const t0 = Date.now();
  const { project_id, rewrite_run_id, user_email, request_id, auth_token, inlined_plan, state } = job.data;

  if (!auth_token) {
    throw new Error('airewrite-orchestrator: missing auth_token (re-enqueue required)');
  }
  // v3 inlined-payload contract — the Base44 orchestrator function rejects
  // any call missing either field with HTTP 400 'legacy_payload_rejected'.
  // Defensive guard here so a malformed re-enqueue surfaces as a clear
  // BullMQ job error instead of an opaque 400 from the function.
  if (!inlined_plan || !state) {
    throw new Error('airewrite-orchestrator: missing inlined_plan or state (v3 contract)');
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
      fn: 'orchestrateAIRewriteRun',
      authToken: auth_token,
      // v3 contract — orchestrator reads run config from inlined_plan +
      // state, never from Base44 (AIRewriteRun read path was broken
      // incident 2026-05-09). Forward both verbatim every tick.
      payload: { project_id, rewrite_run_id, request_id, inlined_plan, state },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:airewrite-orchestrator',
      event: 'airewrite_orchestrator_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, rewrite_run_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
        next_tick: !!result.next_tick,
        finalized: !!result.finalized,
        cost_cap_breached: !!result.cost_cap_breached,
        cost_usd: result.cost_usd,
        cost_cap_usd: result.cost_cap_usd,
        chunk_cursor: result.chunk_cursor,
        chunk_total: result.chunk_total,
        chunks_dispatched: result.chunks_dispatched,
        chunk_in_flight: result.chunk_in_flight,
        chunk_completed: result.chunk_completed,
        chunks_terminal: result.chunks_terminal,
      },
    });

    if (result.next_tick && !result.finalized) {
      const delay = Math.max(500, Math.min(10_000, result.next_tick_delay_ms ?? 1_000));
      // Carry forward the inlined plan AND the freshly-mutated state so the
      // next tick is fully self-contained (no Base44 reads of AIRewriteRun).
      // The orchestrator returns `next_state` containing the post-tick
      // snapshot of cursor/completed/failures/cost/etc. We reuse the same
      // `inlined_plan` (immutable) and replace `state` with the new snapshot.
      const carryForward = {
        ...job.data,
        request_id,
        // If the function returned a next_state snapshot, use it; otherwise
        // fall back to the existing state (defensive — should always be set).
        state: result.next_state ?? job.data.state,
      };
      await orchestratorQueue().add(
        QUEUE_NAMES.AIREWRITE_ORCHESTRATOR,
        carryForward,
        // attempts=1: orchestrator retries cause counter drift. Same lesson
        // as translate / enrich pipelines — stuck tick goes to DLQ for
        // human inspection rather than re-incrementing in_flight counters.
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
    }

    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:airewrite-orchestrator',
      level: 'error',
      event: 'airewrite_orchestrator_tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, rewrite_run_id, user_email, request_id, attempts: job.attemptsMade + 1 },
    });
    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
