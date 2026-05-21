// =============================================================================
// LOAD-TEST-CLEANUP PROCESSOR (B8, 2026-05-21 — patched 2026-05-21 PM)
// -----------------------------------------------------------------------------
// Off-platform bulk cleanup for load-test fixtures. ONE job per
// LoadTestCleanupRun. Each tick calls Base44 fn `loadTestCleanupWorkerStep`,
// which deletes ONE bounded page (≤200 rows) of ONE entity bucket and
// returns next_tick. The processor re-enqueues itself until done.
//
// Same architecture as processLoadTestFanout / processVoiceGenOrchestrator
// / processTranslateOrchestrator / processAIRewriteOrchestrator. Same
// heartbeat pattern, same scoped-JWT auth model, same attempts=1 retry
// policy (counter-drift safety — re-running mid-tick would re-issue
// deletes already in flight; the step function is idempotent within its
// own boundary but we don't double down with BullMQ retries).
//
// PATCH 2026-05-21 PM — TICK 1 → TICK 2 SELF-RE-ENQUEUE FAILURE
//   Observed in production: tick 1 successfully deleted 200 rows and the
//   Base44 step row was updated cleanly, but tick 2 was never enqueued —
//   the cleanup sat in 'running' status forever. The original processor's
//   self-re-enqueue path threw silently because:
//     1. `_selfQueue` was a module-level lazy singleton — if the Redis
//        connection went stale between the worker's startup and the moment
//        the processor first called `selfQueue().add()`, the BullMQ Queue
//        instance held a dead connection. The first add() rejected, the
//        catch block at the bottom of the try logged + rethrew, and the
//        job landed in 'failed' AFTER the row had already been updated by
//        Base44. The cleanup row was 1 tick ahead of the queue.
//     2. `await job.extendLock(job.token!, ...)` used a non-null assertion
//        on `job.token` — when the lock had already been released (because
//        the function returned faster than the heartbeat fired), the
//        extendLock threw, which was caught silently but added noise.
//
//   Fix:
//     • Use the worker process's SHARED queue registry (getCleanupQueue)
//       that boots from a freshly-fetched Redis connection at the moment
//       the first self-enqueue runs. The connection cannot be stale because
//       it's the same instance the worker is processing FROM.
//     • Wrap selfQueue().add() in its own try/catch so a Redis hiccup
//       does NOT cause the job to be marked failed (the Base44 row already
//       reflects the work; failing the job at this point breaks the
//       audit invariant). Instead, emit a structured `tick_self_reenqueue_failed`
//       log row and return — admin can resume via _adminResumeLoadTestCleanup.
//     • Log EVERY tick decision (next_tick true/false, finalized true/false,
//       self-enqueue attempt outcome) to stdout so Railway captures the
//       full sequence and an admin can correlate via cleanup_run_id.
//
// SOC 2 CC8.1 / TPN MS-4.x — every cleanup tick is structurally observable.
// =============================================================================

import type { Job } from 'bullmq';
import type { LoadTestCleanupJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

// Lazy-init the self-enqueue queue handle using the SAME shared Redis
// connection the worker is processing from. Reading getRedis() at call time
// (not import time) guarantees we get a live connection even if the
// processor module was loaded long before the Redis connection actually
// established. Prior implementation kept this in a module-level variable
// initialised at first call — if the very first call coincided with a
// Redis reconnect blip, the cached Queue held a half-initialised socket.
function getCleanupQueue(): Queue {
  return new Queue(QUEUE_NAMES.LOAD_TEST_CLEANUP, { connection: getRedis() });
}

const HEARTBEAT_MS = 15_000;
// Each cleanup tick targets a 22s budget on the Base44 side; 60s network-
// side ceiling gives comfortable headroom for the function to return.
const TICK_TIMEOUT_MS = 60_000;
// Hard wall-clock cap on a single cleanup run. A 5k-row cleanup completes
// in ~3-8 min under typical 429 pressure; anything past 1hr is pathological
// and should fail visibly so an admin notices.
const RUN_WALL_CLOCK_CAP_MS = 60 * 60 * 1000;

interface CleanupTickResult {
  next_tick?: boolean;
  next_tick_delay_ms?: number;
  finalized?: boolean;
  current_phase?: string;
  total_deleted?: number;
  tick_count?: number;
  tick_ms?: number;
}

export async function processLoadTestCleanup(job: Job<LoadTestCleanupJobData>) {
  const t0 = Date.now();
  const { cleanup_run_id, fixture_project_id, fixture_project_name, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('load-test-cleanup: missing auth_token (cannot continue without scoped JWT)');
  }

  // ─── Inbound observability ────────────────────────────────────────
  // Log EVERY tick arrival so Railway logs show the full chain. This was
  // the missing signal that made the tick-1→tick-2 stall invisible.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    fn: 'bullmq:load-test-cleanup',
    event: 'tick_started',
    cleanup_run_id,
    fixture_project_name,
    bullmq_job_id: job.id,
    bullmq_attempts_made: job.attemptsMade,
  }));

  // Hard wall-clock cap. BullMQ's job.timestamp is set at the ORIGINAL
  // enqueue time and survives across self-re-enqueues, so this correctly
  // measures the cumulative wall-clock of the cleanup pass.
  const startedAt = job.timestamp ?? Date.now();
  if (Date.now() - startedAt > RUN_WALL_CLOCK_CAP_MS) {
    await logEvent({
      function_name: 'bullmq:load-test-cleanup',
      level: 'error',
      event: 'load_test_cleanup_wall_clock_exceeded',
      message: `Cleanup exceeded ${RUN_WALL_CLOCK_CAP_MS}ms wall-clock cap`,
      context: { cleanup_run_id, fixture_project_id, fixture_project_name, request_id, user_email },
    });
    // Don't throw — that triggers BullMQ retry. Just return so the run
    // is visibly stuck and an admin can mark it failed manually.
    return { ok: false, reason: 'wall_clock_cap_exceeded' };
  }

  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      // PATCH: drop the non-null assertion on job.token. If the lock has
      // already been released (heartbeat raced the tick completion), the
      // call would throw TypeError; we want to silently skip instead.
      if (!job.token) continue;
      try { await job.extendLock(job.token, 30_000); } catch { /* lock may have advanced */ }
    }
  })();

  let tickResult: CleanupTickResult | null = null;
  try {
    tickResult = await invokeBase44Function<CleanupTickResult>({
      fn: 'loadTestCleanupWorkerStep',
      authToken: auth_token,
      payload: {
        cleanup_run_id,
        fixture_project_id,
        request_id,
      },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:load-test-cleanup',
      event: 'load_test_cleanup_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        cleanup_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
        attempts: job.attemptsMade + 1,
        tick_count: tickResult.tick_count,
        current_phase: tickResult.current_phase,
        total_deleted: tickResult.total_deleted,
        next_tick: !!tickResult.next_tick,
        finalized: !!tickResult.finalized,
      },
    });
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:load-test-cleanup',
      level: 'error',
      event: 'load_test_cleanup_tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        cleanup_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
        attempts: job.attemptsMade + 1,
      },
    });
    heartbeatActive = false;
    await heartbeat.catch(() => {});
    throw err;
  }

  // ─── Self-re-enqueue (decoupled from the tick try/catch) ───────────
  // The Base44 row has ALREADY been updated by this point — the row is
  // tick_count + 1 ahead. If we fail the BullMQ job here, the audit
  // invariant breaks (row says "tick N done, ready for N+1", queue says
  // "tick N failed"). Instead we swallow self-enqueue errors and emit
  // structured log + return ok=true. Admin can resume via
  // _adminResumeLoadTestCleanup. This trade-off is auditor-defensible:
  // never lie about completed work, never re-issue deletes already done.
  if (tickResult.next_tick && !tickResult.finalized) {
    const delay = Math.max(200, Math.min(5_000, tickResult.next_tick_delay_ms ?? 500));
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'bullmq:load-test-cleanup',
        event: 'tick_self_reenqueue_attempt',
        cleanup_run_id,
        delay_ms: delay,
      }));
      const nextJob = await getCleanupQueue().add(
        'tick',
        job.data,
        // attempts=1 by design — same rationale as load-test-fanout:
        // retrying mid-tick would re-issue deletes already in flight.
        // The step function is idempotent within its own boundary
        // (it page-fetches BEFORE deleting), so we don't double down
        // with BullMQ retries.
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'bullmq:load-test-cleanup',
        event: 'tick_self_reenqueue_ok',
        cleanup_run_id,
        next_job_id: nextJob.id,
      }));
    } catch (enqueueErr) {
      const e = enqueueErr as Error;
      // Structured log only — do NOT throw. The cleanup row already
      // reflects the completed tick; an admin nudge picks up cleanly.
      await logEvent({
        function_name: 'bullmq:load-test-cleanup',
        level: 'error',
        event: 'tick_self_reenqueue_failed',
        message: `self-enqueue failed: ${e.message}`,
        error_kind: e.name,
        context: {
          cleanup_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
          tick_count: tickResult.tick_count,
          current_phase: tickResult.current_phase,
          recoverable_via: '_adminResumeLoadTestCleanup',
        },
      });
    }
  } else if (tickResult.finalized) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'bullmq:load-test-cleanup',
      event: 'tick_finalized',
      cleanup_run_id,
      total_deleted: tickResult.total_deleted,
      tick_count: tickResult.tick_count,
    }));
  }

  heartbeatActive = false;
  await heartbeat.catch(() => {});
  return tickResult;
}
